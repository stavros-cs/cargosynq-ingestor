import { SQSEvent, SQSHandler } from 'aws-lambda';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { Resource } from 'sst';
// Use pdf2json as a more reliable alternative for Lambda environments
import PDFParser from 'pdf2json';

async function parsePdfWithPdf2json(pdfBuffer: Buffer): Promise<any> {
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

// Extract session ID for PDF attachments from their path
function extractSessionIdFromAttachmentPath(objectKey: string): string | null {
  // For attachment PDFs, the path includes the original EML filename
  // Example: "attachments/Re_ Follow-Up _ 1198 __ 03072025-1530 [CSID_6c61e850-900a-443e-af5a-f085ace7c8cd]/_ORDR-3372186___PONR-SP-012_25_TS_-Commercial_Invoice_THE17194-4.pdf"
  if (objectKey.startsWith('attachments/')) {
    const pathParts = objectKey.split('/');
    if (pathParts.length >= 2) {
      const emlFolderName = pathParts[1]; // The EML filename part (without .eml)
      // Reconstruct the original EML filename by adding .eml extension
      const originalEmlKey = emlFolderName + '.eml';
      // Generate session ID from the reconstructed EML filename
      return generateSessionId(originalEmlKey);
    }
  }
  return null;
}

export const handler: SQSHandler = async (event: SQSEvent) => {
  console.log('Processing PDF files for content extraction:', JSON.stringify(event, null, 2));

  for (const record of event.Records) {
    try {
      // Parse the message body (contains EventBridge event)
      const eventBridgeEvent = JSON.parse(record.body);
      
      // Extract S3 object information from EventBridge event
      const bucketName = eventBridgeEvent.detail.bucket.name;
      const objectKey = eventBridgeEvent.detail.object.key;
      const s3ETag = eventBridgeEvent.detail.object.etag;
      
      // Check if this is a PDF attachment - if so, skip it (handled by EML attachment extractor)
      if (objectKey.startsWith('attachments/')) {
        console.log(`Skipping PDF attachment ${objectKey} - already processed by EML attachment extractor`);
        continue; // Skip this record
      }
      
      // This is a direct PDF upload - generate session ID and process
      const sessionId = generateSessionId(objectKey, s3ETag);
      console.log(`Processing direct PDF upload: ${objectKey}, session ID: ${sessionId}`);

      // Get the PDF file from S3
      const getObjectCommand = new GetObjectCommand({
        Bucket: bucketName,
        Key: objectKey,
      });
      
      const s3Response = await s3.send(getObjectCommand);
      const pdfBuffer = await streamToBuffer(s3Response.Body);

      if (!pdfBuffer) {
        throw new Error('Failed to read PDF file content');
      }

      // Parse PDF content using pdf2json (more reliable in Lambda)
      const data = await parsePdfWithPdf2json(pdfBuffer);
      const extractedText = data.text;
      
      // Create PDF record for DynamoDB
      const pdfData = {
        id: `pdf-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        sessionId: sessionId,
        fileName: objectKey,
        bucketName: bucketName,
        fileType: 'pdf',
        processedAt: new Date().toISOString(),
        
        // PDF metadata
        fileSize: pdfBuffer.length,
        isValidPdf: true,
        
        // Extracted content from pdf-parse (same as your working code)
        textContent: extractedText || '',
        pageCount: data.numpages || 0,
        
        // Additional metadata from pdf-parse info
        pdfInfo: {
          title: data.info?.Title || '',
          author: data.info?.Author || '',
          subject: data.info?.Subject || '',
          creator: data.info?.Creator || '',
          producer: data.info?.Producer || '',
          creationDate: data.info?.CreationDate || '',
          modDate: data.info?.ModDate || '',
        },
        
        // Content statistics
        characterCount: extractedText?.length || 0,
        wordCount: extractedText ? extractedText.split(/\s+/).filter((word: string) => word.length > 0).length : 0,
      };

      console.log(`Successfully extracted PDF content. Text length: ${extractedText.length}, Pages: ${data.numpages}`);

      // Save to DynamoDB
      const putItemCommand = new PutItemCommand({
        TableName: Resource.CargosynqIngestorRecords.name,
        Item: {
          id: { S: pdfData.id },
          sessionId: { S: pdfData.sessionId },
          fileName: { S: pdfData.fileName },
          bucketName: { S: pdfData.bucketName },
          fileType: { S: pdfData.fileType },
          processedAt: { S: pdfData.processedAt },
          fileSize: { N: pdfData.fileSize.toString() },
          isValidPdf: { BOOL: pdfData.isValidPdf },
          textContent: { S: pdfData.textContent },
          pageCount: { N: pdfData.pageCount.toString() },
          pdfInfo: { S: JSON.stringify(pdfData.pdfInfo) },
          characterCount: { N: pdfData.characterCount.toString() },
          wordCount: { N: pdfData.wordCount.toString() },
        },
      });

      await dynamodb.send(putItemCommand);
      console.log(`PDF record saved to DynamoDB with ID: ${pdfData.id}`);

    } catch (error) {
      // Log the error but consume the message (don't throw)
      // This prevents the message from going back to the queue
      console.error(`Failed to process PDF file. Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      console.error('Error stack:', error instanceof Error ? error.stack : 'No stack trace');
      
      // The message will be consumed and not retried
      // No DynamoDB record will be created for failed PDFs
    }
  }
};

// Utility to convert stream to Buffer (same as your working Lambda)
const streamToBuffer = async (stream: any): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: any[] = [];
    stream.on("data", (chunk: any) => chunks.push(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });