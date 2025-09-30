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

// Extract CSID from email content using the specific format #CSID:uuid#
function extractCSID(subject: string, bodyText: string): string | null {
  // Pattern to match #CSID:uuid# format
  const csidPattern = /#CSID:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})#/gi;
  
  // First check the subject line
  let match = csidPattern.exec(subject);
  if (match) {
    return match[1]; // Return the UUID part (first capture group)
  }
  
  // Reset regex lastIndex for second search
  csidPattern.lastIndex = 0;
  
  // Then check the email body
  match = csidPattern.exec(bodyText);
  if (match) {
    return match[1]; // Return the UUID part (first capture group)
  }
  
  return null; // No CSID found
}

export const handler: SQSHandler = async (event: SQSEvent) => {
  console.log('Processing EML files from SQS messages:', JSON.stringify(event, null, 2));

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
      
      console.log(`Processing EML file: ${objectKey} from bucket: ${bucketName}, Session ID: ${sessionId}`);
      
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
      const subject = parsed.subject || '';
      const bodyText = parsed.text || '';
      
      // Extract CSID from subject or body
      const csid = extractCSID(subject, bodyText);
      
      if (csid) {
        console.log(`Extracted CSID: ${csid} from email: ${objectKey}`);
      }
      
      const emailData = {
        id: `eml-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        sessionId: sessionId,
        fileName: objectKey,
        bucketName: bucketName,
        fileType: 'eml',
        processedAt: new Date().toISOString(),
        
        // Email content
        subject: subject,
        from: parsed.from?.text || '',
        to: Array.isArray(parsed.to) ? parsed.to.map(addr => addr.text).join(', ') : (parsed.to?.text || ''),
        date: parsed.date?.toISOString() || '',
        
        // Email body (prefer HTML, fallback to text)
        bodyText: bodyText,
        bodyHtml: parsed.html || '',
        
        // CSID (if found)
        csid: csid,
        
        // Metadata
        messageId: parsed.messageId || '',
        contentLength: emlContent.length,
        attachmentCount: parsed.attachments?.length || 0,
      };

      // Prepare DynamoDB item
      const dynamoItem: any = {
        id: { S: emailData.id },
        sessionId: { S: emailData.sessionId },
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
      };
      
      // Add CSID to DynamoDB item if found
      if (emailData.csid) {
        dynamoItem.csid = { S: emailData.csid };
      }

      // Store the processed email data in DynamoDB
      const putItemCommand = new PutItemCommand({
        TableName: Resource.CargosynqIngestorRecords.name,
        Item: dynamoItem,
      });

      await dynamodb.send(putItemCommand);
      
      console.log(`Successfully processed EML file: ${objectKey}`);

      // Extract and upload attachments (unified functionality)
      if (parsed.attachments && parsed.attachments.length > 0) {
        console.log(`Found ${parsed.attachments.length} attachments in ${objectKey}`);

        // Process each attachment
        for (let i = 0; i < parsed.attachments.length; i++) {
          const attachment: Attachment = parsed.attachments[i];
          
          // Generate attachment filename
          const originalFilename = attachment.filename || `attachment_${i + 1}`;
          const sanitizedFilename = originalFilename.replace(/[^a-zA-Z0-9._-]/g, '_');
          const attachmentKey = `attachments/${objectKey.replace('.eml', '').replace('.EML', '')}/${sanitizedFilename}`;
          
          // Prepare metadata including CSID if available
          const metadata: any = {
            originalFilename: originalFilename,
            sourceEml: objectKey,
            sessionId: sessionId,
            extractedAt: new Date().toISOString(),
            size: attachment.size?.toString() || '0',
          };
          
          // Add CSID to metadata if found (for downstream processors)
          if (csid) {
            metadata.csid = csid;
          }

          // Upload attachment to S3 with metadata
          const putObjectCommand = new PutObjectCommand({
            Bucket: bucketName,
            Key: attachmentKey,
            Body: attachment.content,
            ContentType: attachment.contentType || 'application/octet-stream',
            Metadata: metadata,
          });

          await s3.send(putObjectCommand);
          console.log(`Uploaded attachment: ${attachmentKey}${csid ? ` with CSID: ${csid}` : ''}`);
        }

        console.log(`Successfully processed ${parsed.attachments.length} attachments from ${objectKey}`);
      }

    } catch (error) {
      console.error('Error processing EML file:', error);
      // In a production environment, you might want to send failed messages to a DLQ
      throw error; // This will cause the message to be retried or sent to DLQ if configured
    }
  }
};