import { SQSEvent, SQSHandler } from 'aws-lambda';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { Resource } from 'sst';
import { simpleParser, ParsedMail, Attachment } from 'mailparser';

const s3 = new S3Client({});
const dynamodb = new DynamoDBClient({});

// Generate consistent session ID from S3 object details
function generateSessionId(objectKey: string, etag?: string): string {
  // Use ETag if available (most reliable), otherwise use object key hash
  const baseString = etag || objectKey;
  // Remove quotes from ETag if present and create a clean session ID
  const cleanBase = baseString.replace(/['"]/g, '');
  return `session-${cleanBase.substring(0, 16)}`;
}

export const handler: SQSHandler = async (event: SQSEvent) => {
  console.log('Processing EML files for attachment extraction:', JSON.stringify(event, null, 2));

  for (const record of event.Records) {
    try {
      // Parse the message body (contains EventBridge event)
      const eventBridgeEvent = JSON.parse(record.body);
      
      // Extract S3 object information from EventBridge event
      const bucketName = eventBridgeEvent.detail.bucket.name;
      const objectKey = eventBridgeEvent.detail.object.key;
      const s3ETag = eventBridgeEvent.detail.object.etag;
      
      // Generate consistent session ID based on original S3 object
      const sessionId = generateSessionId(objectKey, s3ETag);
      
      console.log(`Extracting attachments from EML file: ${objectKey} from bucket: ${bucketName}`);

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
      
      if (!parsed.attachments || parsed.attachments.length === 0) {
        console.log(`No attachments found in EML file: ${objectKey}`);
        continue;
      }

      console.log(`Found ${parsed.attachments.length} attachments in ${objectKey}`);

      // Process each attachment
      for (let i = 0; i < parsed.attachments.length; i++) {
        const attachment: Attachment = parsed.attachments[i];
        
        // Generate attachment filename
        const originalFilename = attachment.filename || `attachment_${i + 1}`;
        const sanitizedFilename = originalFilename.replace(/[^a-zA-Z0-9._-]/g, '_');
        const attachmentKey = `attachments/${objectKey.replace('.eml', '').replace('.EML', '')}/${sanitizedFilename}`;
        
        // Upload attachment to S3
        const putObjectCommand = new PutObjectCommand({
          Bucket: bucketName,
          Key: attachmentKey,
          Body: attachment.content,
          ContentType: attachment.contentType || 'application/octet-stream',
          Metadata: {
            originalFilename: originalFilename,
            sourceEml: objectKey,
            extractedAt: new Date().toISOString(),
            size: attachment.size?.toString() || '0',
          },
        });

        await s3.send(putObjectCommand);
        console.log(`Uploaded attachment: ${attachmentKey}`);

        // Record attachment extraction in DynamoDB
        const attachmentRecord = {
          id: `attachment-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          sessionId: sessionId,
          type: 'attachment',
          sourceEmlFile: objectKey,
          attachmentKey: attachmentKey,
          originalFilename: originalFilename,
          sanitizedFilename: sanitizedFilename,
          contentType: attachment.contentType || 'application/octet-stream',
          size: attachment.size || 0,
          extractedAt: new Date().toISOString(),
          bucketName: bucketName,
        };

        const putAttachmentCommand = new PutItemCommand({
          TableName: Resource.CargosynqIngestorRecords.name,
          Item: {
            id: { S: attachmentRecord.id },
            sessionId: { S: attachmentRecord.sessionId },
            type: { S: attachmentRecord.type },
            sourceEmlFile: { S: attachmentRecord.sourceEmlFile },
            attachmentKey: { S: attachmentRecord.attachmentKey },
            originalFilename: { S: attachmentRecord.originalFilename },
            sanitizedFilename: { S: attachmentRecord.sanitizedFilename },
            contentType: { S: attachmentRecord.contentType },
            size: { N: attachmentRecord.size.toString() },
            extractedAt: { S: attachmentRecord.extractedAt },
            bucketName: { S: attachmentRecord.bucketName },
          },
        });

        await dynamodb.send(putAttachmentCommand);
        console.log(`Recorded attachment in DynamoDB: ${attachmentRecord.id}`);
      }

      console.log(`Successfully processed ${parsed.attachments.length} attachments from ${objectKey}`);

    } catch (error) {
      console.error('Error extracting attachments from EML file:', error);
      // In a production environment, you might want to send failed messages to a DLQ
      throw error; // This will cause the message to be retried or sent to DLQ if configured
    }
  }
};