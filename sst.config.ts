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
    const orderProcessingQueue = new sst.aws.Queue("CargosynqIngestorOrderProcessingQueue", {
      visibilityTimeout: "600 seconds", // 10 minutes for complex processing and API calls
    });
    const orderChangesQueue = new sst.aws.Queue("CargosynqIngestorOrderChangesQueue", {
      visibilityTimeout: "600 seconds", // 10 minutes for API calls and OpenAI processing
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

    // Orders table for storing processed order data from OpenAI
    const ordersTable = new sst.aws.Dynamo("CargosynqIngestorOrders", {
      fields: {
        sessionId: "string",
      },
      primaryIndex: { 
        hashKey: "sessionId",
      },
      stream: "new-and-old-images", // Enable DynamoDB stream
    });

    // IAM role for the Records table Pipe
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

    // IAM role for the Orders table Pipe
    const ordersStreamPipeRole = new aws.iam.Role("CargosynqIngestorOrdersStreamPipeRole", {
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

    // IAM policy for the Records table Pipe role
    new aws.iam.RolePolicy("StreamPipePolicy", {
      role: streamPipeRole.name,
      policy: recordsTable.nodes.table.streamArn.apply(streamArn => {
        const tableArn = streamArn.replace("/stream/*", "").replace(/\/stream\/.*/, "");
        return JSON.stringify({
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
              Resource: streamArn,
            },
            {
              Effect: "Allow",
              Action: [
                "dynamodb:DescribeTable"
              ],
              Resource: tableArn,
            },
            {
              Effect: "Allow",
              Action: "events:PutEvents",
              Resource: "*",
            },
          ],
        });
      }),
    });

    // IAM policy for the Orders table Pipe role
    new aws.iam.RolePolicy("OrdersStreamPipePolicy", {
      role: ordersStreamPipeRole.name,
      policy: ordersTable.nodes.table.streamArn.apply(streamArn => {
        const tableArn = streamArn.replace("/stream/*", "").replace(/\/stream\/.*/, "");
        return JSON.stringify({
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
              Resource: streamArn,
            },
            {
              Effect: "Allow",
              Action: [
                "dynamodb:DescribeTable"
              ],
              Resource: tableArn,
            },
            {
              Effect: "Allow",
              Action: "events:PutEvents",
              Resource: "*",
            },
          ],
        });
      }),
    });

    // AWS Pipe to connect DynamoDB Stream directly to EventBridge
    const streamPipe = new aws.pipes.Pipe("CargosynqIngestorStreamPipe", {
      source: recordsTable.nodes.table.streamArn,
      target: recordsTable.nodes.table.arn.apply(tableArn => {
        // Extract region and account ID from the table ARN
        const arnParts = tableArn.split(":");
        const region = arnParts[3];
        const accountId = arnParts[4];
        return `arn:aws:events:${region}:${accountId}:event-bus/default`;
      }),
      roleArn: streamPipeRole.arn,
      sourceParameters: {
        dynamodbStreamParameters: {
          startingPosition: "LATEST",
          batchSize: 1,
          maximumRecordAgeInSeconds: -1, // Process records indefinitely
        },
      },
      targetParameters: {
        eventbridgeEventBusParameters: {
          detailType: "cargosynq.ingestor",
          source: "cargosynq.dynamodb",
        },
      },
      logConfiguration: {
        cloudwatchLogsLogDestination: {
          logGroupArn: recordsTable.nodes.table.arn.apply(tableArn => {
            const arnParts = tableArn.split(":");
            const region = arnParts[3];
            const accountId = arnParts[4];
            return `arn:aws:logs:${region}:${accountId}:log-group:/aws/vendedlogs/pipes/CargosynqIngestorStreamPipe-873c702`;
          }),
        },
        level: "TRACE",
        includeExecutionDatas: ["ALL"],
      },
    });

    // AWS Pipe to connect Orders DynamoDB Stream to EventBridge
    const ordersStreamPipe = new aws.pipes.Pipe("CargosynqIngestorOrdersStreamPipeV2", {
      source: ordersTable.nodes.table.streamArn,
      target: ordersTable.nodes.table.arn.apply(tableArn => {
        // Extract region and account ID from the table ARN
        const arnParts = tableArn.split(":");
        const region = arnParts[3];
        const accountId = arnParts[4];
        return `arn:aws:events:${region}:${accountId}:event-bus/default`;
      }),
      roleArn: ordersStreamPipeRole.arn,
      sourceParameters: {
        dynamodbStreamParameters: {
          startingPosition: "LATEST",
          batchSize: 1,
          maximumRecordAgeInSeconds: -1, // Process records indefinitely
          maximumRetryAttempts: -1, // Retry indefinitely
        },
      },
      targetParameters: {
        eventbridgeEventBusParameters: {
          detailType: "cargosynq.orders",
          source: "cargosynq.orders.dynamodb",
        },
      },
      logConfiguration: {
        level: "OFF", // Disable logging as shown in CloudFormation
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
        APPSYNC_API_URL: process.env.APPSYNC_API_URL || "",
        APPSYNC_API_KEY: process.env.APPSYNC_API_KEY || "",
      },
      link: [recordsTable],
      timeout: "5 minutes", // Allow time for OpenAI API calls
    });

    // Lambda function for order processing - checks completion and creates orders
    const orderProcessor = new sst.aws.Function("CargosynqIngestorOrderProcessor", {
      handler: "src/handlers/order-processor.handler",
      environment: {
        RECORDS_TABLE: recordsTable.name,
        ORDERS_TABLE: ordersTable.name,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY || "",
      },
      link: [recordsTable, ordersTable],
      timeout: "10 minutes", // Allow time for API calls and OpenAI processing
    });

    // Lambda function for order changes processing - analyzes changes and calls CargoSynq API
    const orderChangesProcessor = new sst.aws.Function("CargosynqIngestorOrderChangesProcessor", {
      handler: "src/handlers/order-changes-processor.handler",
      environment: {
        ORDERS_TABLE: ordersTable.name,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY || "",
        CARGOSYNQ_API_URL: process.env.CARGOSYNQ_API_URL || "https://api.cargosynq.com", // Add your API URL
      },
      link: [ordersTable],
      timeout: "10 minutes", // Allow time for API calls and OpenAI processing
    });

    // EventBridge rule for DynamoDB stream events (EML files from the pipe)
    const dynamoStreamRule = new aws.cloudwatch.EventRule("CargosynqIngestorDynamoStreamRule", {
      eventPattern: JSON.stringify({
        source: ["cargosynq.dynamodb"],
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

    // EventBridge rule for DynamoDB stream events (PDF files from the pipe)
    const dynamoStreamPdfRule = new aws.cloudwatch.EventRule("CargosynqIngestorDynamoStreamPdfRule", {
      eventPattern: JSON.stringify({
        source: ["cargosynq.dynamodb"],
        detail: {
          eventName: ["INSERT"],
          dynamodb: {
            NewImage: {
              fileType: {
                S: ["pdf"]
              }
            }
          }
        }
      }),
    });

    // EventBridge rule for DynamoDB stream events (AI Summary completion)
    const dynamoStreamSummaryRule = new aws.cloudwatch.EventRule("CargosynqIngestorDynamoStreamSummaryRule", {
      eventPattern: JSON.stringify({
        source: ["cargosynq.dynamodb"],
        detail: {
          eventName: ["MODIFY"],
          dynamodb: {
            NewImage: {
              aiSummary: {
                S: [{ exists: true }]
              }
            }
          }
        }
      }),
    });

    // Send EML inserts to email summarizer first
    new aws.cloudwatch.EventTarget("CargosynqIngestorEmailSummaryTarget", {
      rule: dynamoStreamRule.name,
      arn: emailSummaryQueue.arn,
      sqsTarget: {},
    });

    // Send EML inserts to order processor as well
    new aws.cloudwatch.EventTarget("CargosynqIngestorOrderProcessingTarget", {
      rule: dynamoStreamRule.name,
      arn: orderProcessingQueue.arn,
      sqsTarget: {},
    });

    // Send PDF inserts directly to order processor
    new aws.cloudwatch.EventTarget("CargosynqIngestorPdfOrderProcessingTarget", {
      rule: dynamoStreamPdfRule.name,
      arn: orderProcessingQueue.arn,
      sqsTarget: {},
    });

    // Send AI summary completions to order processor
    new aws.cloudwatch.EventTarget("CargosynqIngestorSummaryOrderProcessingTarget", {
      rule: dynamoStreamSummaryRule.name,
      arn: orderProcessingQueue.arn,
      sqsTarget: {},
    });

    // EventBridge rule for Orders DynamoDB stream events (INSERT and MODIFY)
    const ordersStreamRule = new aws.cloudwatch.EventRule("CargosynqIngestorOrdersStreamRule", {
      eventPattern: JSON.stringify({
        source: ["cargosynq.orders.dynamodb"],
        "detail-type": ["cargosynq.orders"],
        detail: {
          eventName: ["INSERT", "MODIFY"]
        }
      }),
    });

    // Send orders with extractedData to order changes processor
    new aws.cloudwatch.EventTarget("CargosynqIngestorOrderChangesTarget", {
      rule: ordersStreamRule.name,
      arn: orderChangesQueue.arn,
      sqsTarget: {},
    });

    // Connect email summary queue to the emailSummarizer Lambda
    emailSummaryQueue.subscribe(emailSummarizer.arn);

    // Connect order processing queue to the orderProcessor Lambda
    orderProcessingQueue.subscribe(orderProcessor.arn);

    // Connect order changes queue to the orderChangesProcessor Lambda
    orderChangesQueue.subscribe(orderChangesProcessor.arn);



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

    // IAM permissions for order processor to access SQS
    new aws.iam.RolePolicy("OrderProcessorSqsPolicy", {
      role: orderProcessor.nodes.role.name,
      policy: orderProcessingQueue.arn.apply(queueArn => 
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

    // IAM permissions for order changes processor to access SQS
    new aws.iam.RolePolicy("OrderChangesProcessorSqsPolicy", {
      role: orderChangesProcessor.nodes.role.name,
      policy: orderChangesQueue.arn.apply(queueArn => 
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

    new aws.sqs.QueuePolicy("OrderProcessingQueuePolicy", {
      queueUrl: orderProcessingQueue.url,
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

    new aws.sqs.QueuePolicy("OrderChangesQueuePolicy", {
      queueUrl: orderChangesQueue.url,
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
