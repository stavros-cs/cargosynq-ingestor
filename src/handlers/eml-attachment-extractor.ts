import { SQSEvent, SQSHandler } from 'aws-lambda';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { Resource } from 'sst';
import { simpleParser, ParsedMail, Attachment } from 'mailparser';
import PDFParser from 'pdf2json';

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

// Parse PDF content using pdf2json (same as PDF processor)
async function parsePdfContent(pdfBuffer: Buffer): Promise<any> {
  return new Promise((resolve, reject) => {
    const pdfParser = new (PDFParser as any)(null, 1);
    
    pdfParser.on('pdfParser_dataError', (errData: any) => {
      console.error('PDF parsing error:', errData.parserError);
      reject(new Error(`PDF parsing failed: ${errData.parserError}`));
    });
    
    pdfParser.on('pdfParser_dataReady', (pdfData: any) => {
      try {
        // Extract text from pdf2json format
        const pages = pdfData.Pages || [];
        let fullText = '';
        
        pages.forEach((page: any, pageIndex: number) => {
          const texts = page.Texts || [];
          texts.forEach((textItem: any) => {
            if (textItem.R && textItem.R.length > 0) {
              textItem.R.forEach((run: any) => {
                if (run.T) {
                  // Decode URI component as pdf2json encodes text
                  fullText += decodeURIComponent(run.T) + ' ';
                }
              });
            }
          });
          fullText += '\n'; // Add newline between pages
        });
        
        // Create pdf-parse compatible result
        const result = {
          text: fullText.trim(),
          numpages: pages.length,
          info: {
            Title: pdfData.Meta?.Title || '',
            Author: pdfData.Meta?.Author || '',
            Subject: pdfData.Meta?.Subject || '',
            Creator: pdfData.Meta?.Creator || '',
            Producer: pdfData.Meta?.Producer || '',
            CreationDate: pdfData.Meta?.CreationDate || '',
            ModDate: pdfData.Meta?.ModDate || '',
          }
        };
        
        resolve(result);
      } catch (error) {
        reject(error);
      }
    });
    
    // Parse the PDF buffer
    pdfParser.parseBuffer(pdfBuffer);
  });
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

        // Check if this is a PDF attachment and extract content
        const isPdf = attachment.contentType === 'application/pdf' || 
                     originalFilename.toLowerCase().endsWith('.pdf');
        
        let attachmentRecord: any;
        
        if (isPdf) {
          console.log(`Processing PDF attachment: ${originalFilename}`);
          try {
            // Extract PDF content
            const pdfData = await parsePdfContent(attachment.content);
            
            // Create comprehensive PDF record with both attachment metadata AND content
            attachmentRecord = {
              id: `pdf-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
              sessionId: sessionId,
              fileType: 'pdf',
              type: 'attachment', // Still mark as attachment for filtering
              sourceEmlFile: objectKey,
              attachmentKey: attachmentKey,
              originalFilename: originalFilename,
              sanitizedFilename: sanitizedFilename,
              contentType: attachment.contentType || 'application/pdf',
              size: attachment.size || 0,
              extractedAt: new Date().toISOString(),
              bucketName: bucketName,
              
              // PDF content fields
              fileName: attachmentKey, // S3 key for the PDF
              isValidPdf: true,
              textContent: pdfData.text || '',
              pageCount: pdfData.numpages || 0,
              pdfInfo: {
                title: pdfData.info?.Title || '',
                author: pdfData.info?.Author || '',
                subject: pdfData.info?.Subject || '',
                creator: pdfData.info?.Creator || '',
                producer: pdfData.info?.Producer || '',
                creationDate: pdfData.info?.CreationDate || '',
                modDate: pdfData.info?.ModDate || '',
              },
              characterCount: pdfData.text?.length || 0,
              wordCount: pdfData.text ? pdfData.text.split(/\s+/).filter((word: string) => word.length > 0).length : 0,
            };
            
            console.log(`Extracted PDF content: ${pdfData.text?.length || 0} characters, ${pdfData.numpages || 0} pages`);
          } catch (pdfError) {
            console.error(`Failed to extract PDF content from ${originalFilename}:`, pdfError);
            
            // Fallback to basic attachment record if PDF parsing fails
            attachmentRecord = {
              id: `pdf-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
              sessionId: sessionId,
              fileType: 'pdf',
              type: 'attachment',
              sourceEmlFile: objectKey,
              attachmentKey: attachmentKey,
              originalFilename: originalFilename,
              sanitizedFilename: sanitizedFilename,
              contentType: attachment.contentType || 'application/pdf',
              size: attachment.size || 0,
              extractedAt: new Date().toISOString(),
              bucketName: bucketName,
              fileName: attachmentKey,
              isValidPdf: false,
              textContent: 'PDF content extraction failed',
              pageCount: 0,
              characterCount: 0,
              wordCount: 0,
            };
          }
        } else {
          // Non-PDF attachment - create basic attachment record
          attachmentRecord = {
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
        }

        // Build DynamoDB item dynamically based on record type
        const dynamoItem: any = {
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
        };
        
        // Add PDF-specific fields if this is a PDF
        if (isPdf) {
          dynamoItem.fileType = { S: 'pdf' };
          dynamoItem.fileName = { S: attachmentRecord.fileName };
          dynamoItem.isValidPdf = { BOOL: attachmentRecord.isValidPdf };
          dynamoItem.textContent = { S: attachmentRecord.textContent };
          dynamoItem.pageCount = { N: attachmentRecord.pageCount.toString() };
          dynamoItem.characterCount = { N: attachmentRecord.characterCount.toString() };
          dynamoItem.wordCount = { N: attachmentRecord.wordCount.toString() };
          
          if (attachmentRecord.pdfInfo) {
            dynamoItem.pdfInfo = { S: JSON.stringify(attachmentRecord.pdfInfo) };
          }
        }

        const putAttachmentCommand = new PutItemCommand({
          TableName: Resource.CargosynqIngestorRecords.name,
          Item: dynamoItem,
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