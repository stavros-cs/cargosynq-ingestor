import { SQSEvent, SQSHandler } from 'aws-lambda';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { Resource } from 'sst';
import { simpleParser, ParsedMail } from 'mailparser';

const s3 = new S3Client({});
const dynamodb = new DynamoDBClient({});

export const handler: SQSHandler = async (event: SQSEvent) => {
  console.log('Processing EML files from SQS messages:', JSON.stringify(event, null, 2));

  for (const record of event.Records) {
    try {
      // Parse the message body (contains EventBridge event)
      const eventBridgeEvent = JSON.parse(record.body);
      
      // Extract S3 object information from EventBridge event
      const bucketName = eventBridgeEvent.detail.bucket.name;
      const objectKey = eventBridgeEvent.detail.object.key;
      
      console.log(`Processing EML file: ${objectKey} from bucket: ${bucketName}`);

      // Get the EML file from S3
      const getObjectCommand = new GetObjectCommand({
        Bucket: bucketName,
        Key: objectKey,
      });
      
      const s3Response = await s3.send(getObjectCommand);
      const emlContent = await s3Response.Body?.transformToString();

      if (!emlContent) {
        throw new Error('Failed to read EML file content');
      }

      // Parse the EML file using mailparser
      const parsed: ParsedMail = await simpleParser(emlContent);
      
      // Extract email data
      const emailData = {
        id: `eml-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        fileName: objectKey,
        bucketName: bucketName,
        fileType: 'eml',
        processedAt: new Date().toISOString(),
        
        // Email content
        subject: parsed.subject || '',
        from: parsed.from?.text || '',
        to: parsed.to?.text || '',
        date: parsed.date?.toISOString() || '',
        
        // Email body (prefer HTML, fallback to text)
        bodyText: parsed.text || '',
        bodyHtml: parsed.html || '',
        
        // Metadata
        messageId: parsed.messageId || '',
        contentLength: emlContent.length,
        attachmentCount: parsed.attachments?.length || 0,
      };

      // Store the processed email data in DynamoDB
      const putItemCommand = new PutItemCommand({
        TableName: Resource.CargosynqIngestorRecords.name,
        Item: {
          id: { S: emailData.id },
          fileName: { S: emailData.fileName },
          bucketName: { S: emailData.bucketName },
          fileType: { S: emailData.fileType },
          processedAt: { S: emailData.processedAt },
          
          // Email fields
          subject: { S: emailData.subject },
          from: { S: emailData.from },
          to: { S: emailData.to },
          date: { S: emailData.date },
          bodyText: { S: emailData.bodyText },
          bodyHtml: { S: emailData.bodyHtml },
          messageId: { S: emailData.messageId },
          
          // Metadata
          contentLength: { N: emailData.contentLength.toString() },
          attachmentCount: { N: emailData.attachmentCount.toString() },
        },
      });

      await dynamodb.send(putItemCommand);
      
      console.log(`Successfully processed EML file: ${objectKey}`);

    } catch (error) {
      console.error('Error processing EML file:', error);
      // In a production environment, you might want to send failed messages to a DLQ
      throw error; // This will cause the message to be retried or sent to DLQ if configured
    }
  }
};