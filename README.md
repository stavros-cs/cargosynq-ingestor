# CargosynqIngestor

A serverless document ingestion system built with AWS SST that processes EML and PDF files uploaded to S3.

## Architecture

The system uses an event-driven architecture with the following components:

### AWS Services
- **S3 Bucket**: File storage with EventBridge notifications
- **EventBridge**: Routes file upload events based on file type
- **SQS Queues**: Decouples processing with separate queues for different operations
- **Lambda Functions**: Serverless processors for different file types and operations
- **DynamoDB**: Stores extracted content and metadata

### Processing Pipeline

#### EML Processing
When an `.eml` file is uploaded:
1. EventBridge routes to both EML queues
2. **EML Processor**: Extracts email content (subject, body, headers)
3. **EML Attachment Extractor**: Extracts attachments and uploads to S3
4. Both create records in DynamoDB

#### PDF Processing
When a `.pdf` file is uploaded:
1. EventBridge routes to PDF content queue
2. **PDF Content Processor**: Extracts text content and metadata using pdf2json
3. Creates record in DynamoDB

## Infrastructure

Built with [SST v3](https://sst.dev) using:
- TypeScript
- AWS CDK/Pulumi
- Event-driven serverless architecture

### Queues
- `CargosynqIngestorEmlQueue` - Email content processing
- `CargosynqIngestorEmlAttachmentQueue` - Email attachment extraction
- `CargosynqIngestorPdfContentQueue` - PDF content processing
- `CargosynqIngestorPdfQueue` - Reserved for future PDF operations

### Lambda Functions
- `CargosynqIngestorEmlProcessor` - Email content extraction
- `CargosynqIngestorEmlAttachmentExtractor` - Email attachment processing
- `CargosynqIngestorPdfContentProcessor` - PDF content extraction

## Getting Started

### Prerequisites
- Node.js 18+
- AWS CLI configured
- SST CLI installed

### Installation

```bash
npm install
```

### Development

```bash
npm run dev
```

### Deployment

```bash
# Deploy to dev stage (default)
npm run deploy

# Deploy to specific stage
npx sst deploy --stage production
```

### Testing

Upload test files to the S3 bucket:

```bash
# Upload EML file
aws s3 cp test.eml s3://your-bucket-name/

# Upload PDF file  
aws s3 cp test.pdf s3://your-bucket-name/
```

## Dependencies

### Runtime
- `@aws-sdk/client-s3` - S3 operations
- `@aws-sdk/client-dynamodb` - DynamoDB operations
- `mailparser` - EML file parsing
- `pdf2json` - PDF content extraction (Lambda-compatible alternative to pdf-parse)

### Development
- `sst` - Serverless framework
- `typescript` - Type safety
- Various AWS Lambda type definitions

## Project Structure

```
├── src/
│   └── handlers/
│       ├── eml-processor.ts          # Email content extraction
│       ├── eml-attachment-extractor.ts # Email attachment processing
│       └── pdf-content-processor.ts   # PDF content extraction
├── sst.config.ts                     # SST infrastructure configuration
├── package.json
└── tsconfig.json
```

## Configuration

The system is configured via `sst.config.ts` with:
- Event-driven architecture using EventBridge
- SQS queues for reliable processing
- Lambda functions with proper IAM permissions
- DynamoDB table for storing processed content

## Notes

- Uses pdf2json instead of pdf-parse for better Lambda compatibility
- Implements dual-queue architecture for EML files (content + attachments)
- All processing is asynchronous and fault-tolerant
- Failed messages are consumed to prevent infinite retries