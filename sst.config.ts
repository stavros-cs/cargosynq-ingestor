/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: "cargosynq-ingestor",
      removal: input?.stage === "production" ? "retain" : "remove",
      protect: ["production"].includes(input?.stage),
      home: "aws",
      providers: { aws: { profile: "developer-sandbox" }}
    };
  },
  async run() {
    const bucket = new sst.aws.Bucket("CargosynqIngestorBucket", {
      transform: {
        policy: (args) => {
          // use sst.aws.iamEdit helper function to manipulate IAM policy
          // containing Output values from components
          args.policy = sst.aws.iamEdit(args.policy, (policy) => {
            policy.Statement.push({
              Effect: "Allow",
              Principal: { Service: "ses.amazonaws.com" },
              Action: "s3:PutObject",
              Resource: $interpolate`arn:aws:s3:::${args.bucket}/*`,
            });
          });
        },
      },
    });

    const emlQueue = new sst.aws.Queue("CargosynqIngestorEmlQueue", {
      visibilityTimeout: "360 seconds", // 6 minutes - longer than Lambda timeout
    });
    const pdfQueue = new sst.aws.Queue("CargosynqIngestorPdfQueue");
    const pdfContentQueue = new sst.aws.Queue("CargosynqIngestorPdfContentQueue", {
      visibilityTimeout: "360 seconds", // 6 minutes - longer than Lambda timeout
    });
    const emailSummaryQueue = new sst.aws.Queue("CargosynqIngestorEmailSummaryQueue", {
      visibilityTimeout: "300 seconds", // 5 minutes for AI API calls
    });
    
    const recordsTable = new sst.aws.Dynamo("CargosynqIngestorRecords", {
      fields: {
        sessionId: "string",
        id: "string",
      },
      primaryIndex: { 
        hashKey: "sessionId", 
        rangeKey: "id" 
      },
      stream: "new-and-old-images", // Enable DynamoDB stream with full record data
    });

    // IAM role for the Pipe
    const streamPipeRole = new aws.iam.Role("CargosynqIngestorStreamPipeRole", {
      assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: {
              Service: "pipes.amazonaws.com",
            },
            Action: "sts:AssumeRole",
          },
        ],
      }),
    });

    // IAM policy for the Pipe role
    new aws.iam.RolePolicy("StreamPipePolicy", {
      role: streamPipeRole.name,
      policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: [
              "dynamodb:DescribeStream",
              "dynamodb:GetRecords",
              "dynamodb:GetShardIterator",
              "dynamodb:ListStreams"
            ],
            Resource: "arn:aws:dynamodb:eu-central-1:585768163538:table/cargosynq-ingestor-dev-CargosynqIngestorRecordsTable-hueohcad/stream/*",
          },
          {
            Effect: "Allow",
            Action: [
              "dynamodb:DescribeTable"
            ],
            Resource: "arn:aws:dynamodb:eu-central-1:585768163538:table/cargosynq-ingestor-dev-CargosynqIngestorRecordsTable-hueohcad",
          },
          {
            Effect: "Allow",
            Action: "events:PutEvents",
            Resource: "*",
          },
        ],
      }),
    });

    // AWS Pipe to connect DynamoDB Stream directly to EventBridge
    const streamPipe = new aws.pipes.Pipe("CargosynqIngestorStreamPipe", {
      source: recordsTable.nodes.table.streamArn,
      target: "arn:aws:events:eu-central-1:585768163538:event-bus/default", // Hard-code for now
      roleArn: streamPipeRole.arn,
      sourceParameters: {
        dynamodbStreamParameters: {
          startingPosition: "LATEST",
          batchSize: 1,
        },
        filterCriteria: {
          filters: [{
            pattern: JSON.stringify({
              eventName: ["INSERT"],
              dynamodb: {
                NewImage: {
                  fileType: {
                    S: ["eml"]
                  }
                }
              }
            })
          }]
        }
      },
    });

    // Enable EventBridge notifications for the S3 bucket
    new aws.s3.BucketNotification("CargosynqIngestorBucketNotification", {
      bucket: bucket.name,
      eventbridge: true,
    });

    // EventBridge rule for PDF files (case insensitive)
    const pdfRule = new aws.cloudwatch.EventRule("CargosynqIngestorPdfRule", {
      eventPattern: bucket.name.apply(bucketName => JSON.stringify({
        source: ["aws.s3"],
        "detail-type": ["Object Created"],
        detail: {
          bucket: {
            name: [bucketName],
          },
          object: {
            key: [
              { suffix: ".pdf" },
              { suffix: ".PDF" }
            ],
          },
        },
      })),
    });

    // EventBridge rule for EML files (case insensitive)
    const emlRule = new aws.cloudwatch.EventRule("CargosynqIngestorEmlRule", {
      eventPattern: bucket.name.apply(bucketName => JSON.stringify({
        source: ["aws.s3"],
        "detail-type": ["Object Created"],
        detail: {
          bucket: {
            name: [bucketName],
          },
          object: {
            key: [
              { suffix: ".eml" },
              { suffix: ".EML" }
            ],
          },
        },
      })),
    });

    // EventBridge targets to send messages to SQS queues
    // Only send PDF events to the content processing queue (not the unused pdfQueue)
    new aws.cloudwatch.EventTarget("CargosynqIngestorPdfContentTarget", {
      rule: pdfRule.name,
      arn: pdfContentQueue.arn,
      sqsTarget: {},
    });

    new aws.cloudwatch.EventTarget("CargosynqIngestorEmlTarget", {
      rule: emlRule.name,
      arn: emlQueue.arn,
      sqsTarget: {},
    });



    // Lambda function to process EML files
    const emlProcessor = new sst.aws.Function("CargosynqIngestorEmlProcessor", {
      handler: "src/handlers/eml-processor.handler",
      environment: {
        BUCKET_NAME: bucket.name,
        RECORDS_TABLE: recordsTable.name,
      },
      link: [bucket, recordsTable],
    });

    // Lambda function to extract attachments from EML files


    // Lambda function to process PDF content
    const pdfContentProcessor = new sst.aws.Function("CargosynqIngestorPdfContentProcessor", {
      handler: "src/handlers/pdf-content-processor.handler",
      environment: {
        BUCKET_NAME: bucket.name,
        RECORDS_TABLE: recordsTable.name,
      },
      link: [bucket, recordsTable],
      timeout: "3 minutes", // Timeout for PDF processing
      nodejs: {
        esbuild: {
          // Bundle pdf-parse normally but handle any canvas dependencies
          external: ["canvas"],
        },
      },
    });

    // Lambda function for email summarization using OpenAI
    const emailSummarizer = new sst.aws.Function("CargosynqIngestorEmailSummarizer", {
      handler: "src/handlers/email-summarizer.handler",
      environment: {
        RECORDS_TABLE: recordsTable.name,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY || "", // Set this in your environment
      },
      link: [recordsTable],
      timeout: "5 minutes", // Allow time for OpenAI API calls
    });

    // EventBridge rule for DynamoDB stream events (EML record inserts)
    const dynamoStreamRule = new aws.cloudwatch.EventRule("CargosynqIngestorDynamoStreamRule", {
      eventPattern: JSON.stringify({
        source: ["aws.dynamodb"],
        "detail-type": ["DynamoDB Stream Record"],
        detail: {
          eventName: ["INSERT"],
          dynamodb: {
            NewImage: {
              fileType: {
                S: ["eml"]
              }
            }
          }
        }
      }),
    });

    new aws.cloudwatch.EventTarget("CargosynqIngestorEmailSummaryTarget", {
      rule: dynamoStreamRule.name,
      arn: emailSummaryQueue.arn,
      sqsTarget: {},
    });

    // Connect email summary queue to the emailSummarizer Lambda
    emailSummaryQueue.subscribe(emailSummarizer.arn);



    // IAM permissions for email summarizer to access SQS
    new aws.iam.RolePolicy("EmailSummarizerSqsPolicy", {
      role: emailSummarizer.nodes.role.name,
      policy: emailSummaryQueue.arn.apply(queueArn => 
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: [
                "sqs:ReceiveMessage",
                "sqs:DeleteMessage",
                "sqs:GetQueueAttributes"
              ],
              Resource: queueArn,
            },
          ],
        })
      ),
    });

    // IAM policy to allow EventBridge to send messages to SQS queues
    new aws.sqs.QueuePolicy("EmlQueuePolicy", {
      queueUrl: emlQueue.url,
      policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "EventBridgeAccess",
            Effect: "Allow",
            Principal: {
              Service: "events.amazonaws.com",
            },
            Action: "sqs:SendMessage",
            Resource: "*",
          },
        ],
      }),
    });



    new aws.sqs.QueuePolicy("EmailSummaryQueuePolicy", {
      queueUrl: emailSummaryQueue.url,
      policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "EventBridgeAccess",
            Effect: "Allow",
            Principal: {
              Service: "events.amazonaws.com",
            },
            Action: "sqs:SendMessage",
            Resource: "*",
          },
        ],
      }),
    });

    new aws.sqs.QueuePolicy("PdfQueuePolicy", {
      queueUrl: pdfQueue.url,
      policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "EventBridgeAccess",
            Effect: "Allow",
            Principal: {
              Service: "events.amazonaws.com",
            },
            Action: "sqs:SendMessage",
            Resource: "*",
          },
        ],
      }),
    });

    new aws.sqs.QueuePolicy("PdfContentQueuePolicy", {
      queueUrl: pdfContentQueue.url,
      policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "EventBridgeAccess",
            Effect: "Allow",
            Principal: {
              Service: "events.amazonaws.com",
            },
            Action: "sqs:SendMessage",
            Resource: "*",
          },
        ],
      }),
    });

    // Lambda permissions for EML processor
    new aws.iam.RolePolicy("EmlProcessorSqsPolicy", {
      role: emlProcessor.nodes.role.name,
      policy: emlQueue.arn.apply(queueArn => JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: [
              "sqs:ReceiveMessage",
              "sqs:DeleteMessage",
              "sqs:GetQueueAttributes"
            ],
            Resource: queueArn
          }
        ]
      }))
    });



    // Lambda permissions for PDF content processor
    new aws.iam.RolePolicy("PdfContentProcessorSqsPolicy", {
      role: pdfContentProcessor.nodes.role.name,
      policy: pdfContentQueue.arn.apply(queueArn => JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: [
              "sqs:ReceiveMessage",
              "sqs:DeleteMessage",
              "sqs:GetQueueAttributes"
            ],
            Resource: queueArn
          }
        ]
      }))
    });

    // Configure SQS to trigger the EML processor
    new aws.lambda.EventSourceMapping("EmlProcessorEventSource", {
      eventSourceArn: emlQueue.arn,
      functionName: emlProcessor.name,
      batchSize: 10,
      maximumBatchingWindowInSeconds: 5,
    });



    // Configure SQS to trigger the PDF content processor
    new aws.lambda.EventSourceMapping("PdfContentProcessorEventSource", {
      eventSourceArn: pdfContentQueue.arn,
      functionName: pdfContentProcessor.name,
      batchSize: 10,
      maximumBatchingWindowInSeconds: 5,
    });

    return {
      bucket: bucket.name,
      emlQueue: emlQueue.url,
      pdfQueue: pdfQueue.url,
      pdfContentQueue: pdfContentQueue.url,
      recordsTable: recordsTable.name,
      emlProcessor: emlProcessor.name,
      pdfContentProcessor: pdfContentProcessor.name,
    };
  },
});
