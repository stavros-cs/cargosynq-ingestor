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
    const emlAttachmentQueue = new sst.aws.Queue("CargosynqIngestorEmlAttachmentQueue", {
      visibilityTimeout: "360 seconds", // 6 minutes - longer than Lambda timeout
    });
    const pdfQueue = new sst.aws.Queue("CargosynqIngestorPdfQueue");
    const pdfContentQueue = new sst.aws.Queue("CargosynqIngestorPdfContentQueue", {
      visibilityTimeout: "360 seconds", // 6 minutes - longer than Lambda timeout
    });
    
    const recordsTable = new sst.aws.Dynamo("CargosynqIngestorRecords", {
      fields: {
        id: "string",
      },
      primaryIndex: { hashKey: "id" },
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

    new aws.cloudwatch.EventTarget("CargosynqIngestorEmlAttachmentTarget", {
      rule: emlRule.name,
      arn: emlAttachmentQueue.arn,
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
    const emlAttachmentExtractor = new sst.aws.Function("CargosynqIngestorEmlAttachmentExtractor", {
      handler: "src/handlers/eml-attachment-extractor.handler",
      environment: {
        BUCKET_NAME: bucket.name,
        RECORDS_TABLE: recordsTable.name,
      },
      link: [bucket, recordsTable],
      timeout: "5 minutes", // Longer timeout for processing large attachments
    });

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

    new aws.sqs.QueuePolicy("EmlAttachmentQueuePolicy", {
      queueUrl: emlAttachmentQueue.url,
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

    // Lambda permissions for attachment extractor
    new aws.iam.RolePolicy("EmlAttachmentExtractorSqsPolicy", {
      role: emlAttachmentExtractor.nodes.role.name,
      policy: emlAttachmentQueue.arn.apply(queueArn => JSON.stringify({
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

    // Configure SQS to trigger the attachment extractor
    new aws.lambda.EventSourceMapping("EmlAttachmentExtractorEventSource", {
      eventSourceArn: emlAttachmentQueue.arn,
      functionName: emlAttachmentExtractor.name,
      batchSize: 5, // Smaller batch for attachment processing
      maximumBatchingWindowInSeconds: 10,
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
      emlAttachmentQueue: emlAttachmentQueue.url,
      pdfQueue: pdfQueue.url,
      pdfContentQueue: pdfContentQueue.url,
      recordsTable: recordsTable.name,
      emlProcessor: emlProcessor.name,
      emlAttachmentExtractor: emlAttachmentExtractor.name,
      pdfContentProcessor: pdfContentProcessor.name,
    };
  },
});
