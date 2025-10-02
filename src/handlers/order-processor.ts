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
    let orderInfo = null;

    for (const record of records) {
      /*
      if (record.csid) {
        csid = record.csid;
        // fetch GET from api using the csid
        const response = await fetch(`https://17jbbnvat6.execute-api.eu-central-1.amazonaws.com/orders?csid=eq.${encodeURIComponent(csid)}`, {
            method: 'GET',
            headers: {
            'Authorization': `12345`,
            'Content-Type': 'application/json'
            }
        });
        orderInfo = await response.json();
        //combinedContent += `--- Segment type: cargosynqorder ---\n${JSON.stringify(orderInfo)}\n\n`;
        
      }
        */
      


      /*if (record.aiSummary) {
        combinedContent += `Email Summary:\n${record.aiSummary}\n\n`;
      }*/

      if (record.subject) {
        combinedContent += `--- Segment type: mailsubject ---\n${record.subject}\n\n`;
      }

      if (record.bodyText) {
        combinedContent += `--- Segment type: mailbody ---\n${record.bodyText}\n\n`;
      }
      
      if (record.textContent) {
        //combinedContent += `Document Content:\n${record.textContent}\n\n`;
        combinedContent += `--- Segment type: pdftextparse ---\n${record.textContent}\n\n`;
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
      extractedData: orderData
      //...orderData
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
    const prompt = `You are a data extraction assistant that pulls structured data from unstructured invoice text.  

        The invoice may include up to four labeled segments—**mailbody**, **mailsubject**, **pdftextocr**, **cargosynqorder** and **pdftextparse**—but not all will always be present, and some may be empty or incomplete. Treat all available segments as one document:
        
        - **mailbody:** Email body text (use for dates and email addresses).
        - **mailsubject:** Email subject text (use for po number and references).
        - **pdftextocr:** PDF text from OCR (use for layout and placement cues).
        - **pdftextparse:** PDF text from parsing libraries (use for text accuracy).
        
        If a segment is missing or contains insufficient data, proceed with the rest. Before proceeding in extractions you should use the two versions of pdftextocr and pdftextparse to reconstruct a single document. You should use primarly 
        the pdftextocr and compare to pdftextparse to fix OCR failures.

        Your task is to extract from the mailbody, mailsubject, pdftextocr and pdftextparse the following fields and output **only** raw JSON in this exact structure (no markdown fences):
        
        
        {
          "poNumber": "...",
          "isReady": "...",
          "otherReferences": [                // optional
            { "type": "...", "value": "..." }
          ],
          "supplierName": "...",
          "vesselName": "...",
          "clientName": "...",
          "clientEmailAddress": "...",       // from mailbody signature
          "supplierEmailAddress": "...",     // from mailbody or PDF header
          "expectedReadinessDate": "...",    // optional, YYYY-MM-DD (found in mailbody)
          "actualReadinessDate": "...",      // optional, YYYY-MM-DD (only from mailbody)
          "packingDetails": [                  // optional
            {
              "length": ...,                   // numeric
              "width": ...,                    // numeric
              "height": ...,                   // numeric
              "weight": ...,                   // numeric
              "packaging_type": "...",       // string
              "metric_system": "..."         // e.g. "SI" or "imperial"
            }
          ],
          "lineItems": [
            {
              "description": "...",
              "quantity": ...,                 // numeric
              "unitcost": ...,                 // numeric
              "currency": "...",
              "partnumber": "...",           // optional
              "hscode": "...",               // optional
              "unitofmeasurement": "...",    // two-letter code (e.g., KG, MT, PC)
              "countryoforigin": "..."       // two-letter code (optional)
            }
          ],
          invoiceTotal: {
            "currency": "...",
            "value": ...                     // numeric
          }
        }

        Note: Do not confuse vessel ETA (Estimated Time of Arrival) or ETD (Estimated Time of Departure) entries with expectedReadinessDate or actualReadinessDate; ignore any ETA/ETD values.
        
        **Field definitions**
        
        - **poNumber:** Purchase Order number. In case of a pdf extraction if you identify a "your reference" attribute that means that this is the client's purchase order number. 
        - **isReady:** Boolean if the order is ready. 
        - **otherReferences:** Optional array of additional references (e.g., supplier reference, vessel IMO) as objects with type and value.
        - **supplierName:** Supplier’s name.
        - **vesselName:** Vessel’s name. Should not be confused with sea port names.
        - **clientName:** Client’s name.
        - **clientEmailAddress:** Client’s email address (found in the mailbody signature).
        - **supplierEmailAddress:** Supplier’s email address (from mailbody or PDF header).
        - **expectedReadinessDate:** Optional planned readiness date (use ONLY dates extracted from  mailbody segments; format YYYY-MM-DD). 
        - **actualReadinessDate:** Actual readiness date. If the order is ready then populate this value with the date from the header of the mail. This can be populated only if isReady is true. isReady boolean takes priority. If false do not try to extract this value. 
        - **packingDetails:** Optional array of package measurement objects. In case of mentioning multiple items then create the relevante objects. For example if says 'three carton boxes' then create three packing details records. Each including:
          - length, width, height, weight: Numeric dimensions/weight.
          - packaging_type: Type of packaging (string).
          - metric_system: Measurement system (e.g., “SI” or “imperial”).
        - **lineItems:** Array of invoice line items, each including:
          - description: Item description.
          - quantity: Numeric quantity.
          - unitcost: Numeric unit cost (appears after quantity).
          - currency: Currency code (e.g., USD, EUR).
          - partnumber: Optional internal part/reference number.
          - hscode: Optional Harmonized System code.
          - unitofmeasurement: Two-letter unit code (e.g., KG, MT, PC).
          - countryoforigin: Optional two-letter country code of origin.
        - **invoiceTotal:** Object with currency and value for the invoice total.

        **Tip:** Instructions: Discovering supplier name and email. It is very common for supplier name and email to be found on the footer of documents.

        **Tip:** Instructions: If packing details are discovered then the order is ready. Also if a packing list is provided then the order is ready. 

        **Tip:** Instructions: Handling Readiness Fields

          Key Fields: isReady, expectedReadinessDate, actualReadinessDate determine order status.
          If the supplier says the order is ready (or packed and ready for pickup):
            Set isReady = true
            Set actualReadinessDate to the email header date
          If the order is not ready:
            Set isReady = false
            Extract or infer the readiness date from the message and populate expectedReadinessDate
          When the supplier gives an approximate timeframe:
            "in 2 weeks" → expectedReadinessDate = today + 14 days
            "next week" → expectedReadinessDate = today + 7 days
            "next month" or "in a month" → expectedReadinessDate = today + 30 days
          Use contextual judgment if the date is approximate. Always prefer specific dates when available.

        **Tip:** To increase confidence, you may multiply quantity × unitcost for each line item and compare the sum to the invoice total—but do not block extraction if they do not match.        
        `;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: prompt
        },
        {
          role: 'user', 
          content: content
        }
      ],
      temperature: 0.1,
      max_tokens: 1000
    });

    const content_text = response.choices[0]?.message?.content;
    if (!content_text) {
      throw new Error('No response from OpenAI');
    }

    // Strip markdown code blocks if present
    let cleanedContent = content_text.trim();
    if (cleanedContent.startsWith('```json')) {
      cleanedContent = cleanedContent.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    } else if (cleanedContent.startsWith('```')) {
      cleanedContent = cleanedContent.replace(/^```\s*/, '').replace(/\s*```$/, '');
    }

    // Parse the JSON response
    const orderData: OrderData = JSON.parse(cleanedContent);
    console.log('Extracted order data:', orderData);
    
    return orderData;

  } catch (error) {
    console.error('Error extracting order data with OpenAI:', error);
    // Return empty object on error
    return {};
  }
}