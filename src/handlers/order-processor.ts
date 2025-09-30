import { SQSEvent, SQSHandler } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import OpenAI from 'openai';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

interface DynamoDBRecord {
  id: string;
  fileType: 'eml' | 'pdf';
  sessionId: string;
  attachmentCount?: number;
  pdfAttachmentCount?: number;
  aiSummary?: string;
  textContent?: string;
  csid?: string;
  emlRecordId?: string;
  processingStatus?: 'pending' | 'completed' | 'error';
  createdAt: string;
  [key: string]: any;
}

interface OrderData {
  customerName?: string;
  shipperName?: string;
  consigneeName?: string;
  portOfLoading?: string;
  portOfDischarge?: string;
  estimatedDeparture?: string;
  estimatedArrival?: string;
  cargoDescription?: string;
  containerNumbers?: string[];
  bookingReference?: string;
  billOfLadingNumber?: string;
  [key: string]: any;
}

export const handler: SQSHandler = async (event: SQSEvent) => {
  console.log('Order processor received event:', JSON.stringify(event, null, 2));

  for (const record of event.Records) {
    try {
      // Parse the DynamoDB stream event from the SQS message
      const dynamoEvent = JSON.parse(record.body);
      console.log('Processing DynamoDB event:', JSON.stringify(dynamoEvent, null, 2));

      const newImage = dynamoEvent.detail?.dynamodb?.NewImage;
      if (!newImage) {
        console.log('No NewImage found in DynamoDB event');
        continue;
      }

      // Extract record details from DynamoDB format
      const recordId = newImage.id?.S;
      const fileType = newImage.fileType?.S;
      const sessionId = newImage.sessionId?.S;

      if (!recordId || !fileType || !sessionId) {
        console.log('Missing required fields:', { recordId, fileType, sessionId });
        continue;
      }

      console.log(`Processing record: ${recordId} (${fileType}) for session: ${sessionId}`);

      // Check if processing is complete for this session
      const isComplete = await checkProcessingCompletion(sessionId, recordId, fileType);
      
      if (isComplete) {
        console.log(`Processing complete for session ${sessionId}, creating order`);
        await createOrder(sessionId);
      } else {
        console.log(`Processing not yet complete for session ${sessionId}`);
      }

    } catch (error) {
      console.error('Error processing record:', error);
      // Continue processing other records even if one fails
    }
  }
};

async function checkProcessingCompletion(sessionId: string, triggerRecordId: string, triggerFileType: string): Promise<boolean> {
  try {
    // Get all records for this session
    const queryResult = await docClient.send(new QueryCommand({
      TableName: process.env.RECORDS_TABLE!,
      KeyConditionExpression: 'sessionId = :sessionId',
      ExpressionAttributeValues: {
        ':sessionId': sessionId
      }
    }));

    const records: DynamoDBRecord[] = queryResult.Items as DynamoDBRecord[];
    
    if (!records || records.length === 0) {
      console.log(`No records found for session ${sessionId}`);
      return false;
    }

    console.log(`Found ${records.length} records for session ${sessionId}`);

    // Find EML and PDF records
    const emlRecords = records.filter(r => r.fileType === 'eml');
    const pdfRecords = records.filter(r => r.fileType === 'pdf');

    console.log(`EML records: ${emlRecords.length}, PDF records: ${pdfRecords.length}`);

    // Rule 1: Direct-upload PDF (no EML records)
    if (emlRecords.length === 0 && pdfRecords.length > 0) {
      // Check if all PDF records have content extracted
      const allPdfsProcessed = pdfRecords.every(pdf => pdf.textContent && pdf.textContent.length > 0);
      console.log(`Direct PDF upload - All PDFs processed: ${allPdfsProcessed}`);
      return allPdfsProcessed;
    }

    // Rule 2: EML with no PDF attachments
    if (emlRecords.length > 0 && pdfRecords.length === 0) {
      // Check if all EML records have summaries and attachment count is 0
      const allEmlsProcessed = emlRecords.every(eml => 
        eml.aiSummary && 
        eml.aiSummary.length > 0 && 
        (eml.attachmentCount === 0 || eml.pdfAttachmentCount === 0)
      );
      console.log(`EML with no PDFs - All EMLs processed: ${allEmlsProcessed}`);
      return allEmlsProcessed;
    }

    // Rule 3 & 4: EML with PDF attachments
    if (emlRecords.length > 0 && pdfRecords.length > 0) {
      // Check if all EML records have summaries
      const allEmlsProcessed = emlRecords.every(eml => 
        eml.aiSummary && eml.aiSummary.length > 0
      );

      // Check if all PDF records have content extracted
      const allPdfsProcessed = pdfRecords.every(pdf => 
        pdf.textContent && pdf.textContent.length > 0
      );

      // Check if PDF attachment counts match
      let attachmentCountsMatch = true;
      for (const eml of emlRecords) {
        if (eml.pdfAttachmentCount && eml.pdfAttachmentCount > 0) {
          const relatedPdfs = pdfRecords.filter(pdf => pdf.emlRecordId === eml.id);
          if (relatedPdfs.length !== eml.pdfAttachmentCount) {
            attachmentCountsMatch = false;
            console.log(`Attachment count mismatch for EML ${eml.id}: expected ${eml.pdfAttachmentCount}, found ${relatedPdfs.length}`);
            break;
          }
        }
      }

      const isComplete = allEmlsProcessed && allPdfsProcessed && attachmentCountsMatch;
      console.log(`EML with PDFs - EMLs: ${allEmlsProcessed}, PDFs: ${allPdfsProcessed}, Counts: ${attachmentCountsMatch} = ${isComplete}`);
      return isComplete;
    }

    return false;
  } catch (error) {
    console.error('Error checking processing completion:', error);
    return false;
  }
}

async function createOrder(sessionId: string): Promise<void> {
  try {
    // Check if order already exists for this session
    const existingOrder = await docClient.send(new GetCommand({
      TableName: process.env.ORDERS_TABLE!,
      Key: { sessionId }
    }));

    if (existingOrder.Item) {
      console.log(`Order already exists for session ${sessionId}`);
      return;
    }

    // Get all records for this session to compile information
    const queryResult = await docClient.send(new QueryCommand({
      TableName: process.env.RECORDS_TABLE!,
      KeyConditionExpression: 'sessionId = :sessionId',
      ExpressionAttributeValues: {
        ':sessionId': sessionId
      }
    }));

    const records: DynamoDBRecord[] = queryResult.Items as DynamoDBRecord[];
    
    // Compile all text content for OpenAI processing
    let combinedContent = '';
    let csid = '';

    for (const record of records) {
      if (record.csid) {
        csid = record.csid;
      }
      
      if (record.aiSummary) {
        combinedContent += `Email Summary:\n${record.aiSummary}\n\n`;
      }
      
      if (record.textContent) {
        combinedContent += `Document Content:\n${record.textContent}\n\n`;
      }
    }

    if (!combinedContent.trim()) {
      console.error('No content found for order creation');
      return;
    }

    console.log(`Generating order data for session ${sessionId} with CSID: ${csid}`);

    // Call OpenAI to extract structured order information
    const orderData = await extractOrderData(combinedContent);

    // Create the order record
    const orderRecord = {
      sessionId,
      csid: csid || 'unknown',
      createdAt: new Date().toISOString(),
      processingStatus: 'completed',
      recordCount: records.length,
      ...orderData
    };

    await docClient.send(new PutCommand({
      TableName: process.env.ORDERS_TABLE!,
      Item: orderRecord
    }));

    console.log(`Order created successfully for session ${sessionId}`);

  } catch (error) {
    console.error('Error creating order:', error);
    throw error;
  }
}

async function extractOrderData(content: string): Promise<OrderData> {
  try {
    const prompt = `You are a shipping and logistics expert. Extract structured order information from the following shipping documents and email content. 

Extract the following information if available:
- Customer Name (the party placing/managing the order)
- Shipper Name (the party sending the goods)  
- Consignee Name (the party receiving the goods)
- Port of Loading (departure port)
- Port of Discharge (arrival port)
- Estimated Departure Date
- Estimated Arrival Date  
- Cargo Description (what is being shipped)
- Container Numbers (list of container IDs)
- Booking Reference Number
- Bill of Lading Number

Content to analyze:
${content}

Return ONLY a valid JSON object with the extracted information. Use null for missing information. Use camelCase for property names.`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are a shipping and logistics data extraction expert. Always respond with valid JSON only.'
        },
        {
          role: 'user', 
          content: prompt
        }
      ],
      temperature: 0.1,
      max_tokens: 1000
    });

    const content_text = response.choices[0]?.message?.content;
    if (!content_text) {
      throw new Error('No response from OpenAI');
    }

    // Parse the JSON response
    const orderData: OrderData = JSON.parse(content_text);
    console.log('Extracted order data:', orderData);
    
    return orderData;

  } catch (error) {
    console.error('Error extracting order data with OpenAI:', error);
    // Return empty object on error
    return {};
  }
}