import { SQSEvent, SQSHandler } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import OpenAI from 'openai';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

interface OrderRecord {
  sessionId: string;
  csid?: string;
  extractedData?: any;
  createdAt: string;
  processingStatus: string;
  recordCount: number;
  [key: string]: any;
}

interface CargoSynqApiResponse {
  success: boolean;
  data?: any;
  error?: string;
}

export const handler: SQSHandler = async (event: SQSEvent) => {
  console.log('Order changes processor received event:', JSON.stringify(event, null, 2));

  for (const record of event.Records) {
    try {
      // Parse the DynamoDB stream event from the SQS message
      const dynamoEvent = JSON.parse(record.body);
      console.log('Processing DynamoDB event:', JSON.stringify(dynamoEvent, null, 2));

      const newImage = dynamoEvent.detail?.dynamodb?.NewImage;
      const oldImage = dynamoEvent.detail?.dynamodb?.OldImage;
      
      if (!newImage) {
        console.log('No NewImage found in DynamoDB event');
        continue;
      }

      // Extract session ID from DynamoDB format
      const sessionId = newImage.sessionId?.S;
      if (!sessionId) {
        console.log('No sessionId found in DynamoDB event');
        continue;
      }

      console.log(`Processing order changes for session: ${sessionId}`);

      // Get the current order record from DynamoDB
      const currentOrder = await getCurrentOrder(sessionId);
      if (!currentOrder) {
        console.error(`Order not found for session ${sessionId}`);
        continue;
      }

      console.log('Current order:', JSON.stringify(currentOrder, null, 2));

      // Get existing record from CargoSynq API
      const existingRecord = await getCargoSynqRecord(currentOrder.csid || sessionId);
      console.log('Existing CargoSynq record:', JSON.stringify(existingRecord, null, 2));

      // Extract the new data from DynamoDB format
      const extractedData = parseExtractedData(newImage.extractedData?.S);
      console.log('New extracted data:', JSON.stringify(extractedData, null, 2));

      // Analyze changes using OpenAI
      const changesAnalysis = await analyzeChanges(existingRecord, extractedData, currentOrder);
      console.log('Changes analysis:', JSON.stringify(changesAnalysis, null, 2));

      // For now, just log the results as requested
      console.log('=== ORDER CHANGES PROCESSING RESULTS ===');
      console.log('Session ID:', sessionId);
      console.log('CSID:', currentOrder.csid);
      console.log('Existing Record:', existingRecord);
      console.log('New Extracted Data:', extractedData);
      console.log('Changes Analysis:', changesAnalysis);
      console.log('========================================');

    } catch (error) {
      console.error('Error processing order changes:', error);
      // Continue processing other records even if one fails
    }
  }
};

async function getCurrentOrder(sessionId: string): Promise<OrderRecord | null> {
  try {
    const result = await docClient.send(new GetCommand({
      TableName: process.env.ORDERS_TABLE!,
      Key: { sessionId }
    }));

    return result.Item as OrderRecord || null;
  } catch (error) {
    console.error('Error getting current order:', error);
    return null;
  }
}

async function getCargoSynqRecord(csid: string): Promise<any> {
  try {
    // fetch GET from api using the csid
    const response = await fetch(`https://17jbbnvat6.execute-api.eu-central-1.amazonaws.com/orders?csid=eq.${encodeURIComponent(csid)}`, {
      method: 'GET',
      headers: {
        'Authorization': `12345`,
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) {
      console.error(`CargoSynq API request failed: ${response.status} ${response.statusText}`);
      return null;
    }
    
    const orderInfo = await response.json();
    console.log(`CargoSynq API response for csid ${csid}:`, orderInfo);
    
    return orderInfo;
  } catch (error) {
    console.error('Error calling CargoSynq API:', error);
    return null;
  }
}

function parseExtractedData(extractedDataString: string): any {
  try {
    return JSON.parse(extractedDataString || '{}');
  } catch (error) {
    console.error('Error parsing extracted data:', error);
    return {};
  }
}

async function analyzeChanges(existingRecord: any, extractedData: any, currentOrder: OrderRecord): Promise<any> {
  try {
    const prompt = `You are a shipping and logistics expert. Analyze the differences between an existing order record and newly extracted data to identify what has changed.

      Existing Record:
      ${JSON.stringify(existingRecord, null, 2)}

      New Extracted Data:
      ${JSON.stringify(currentOrder.extractedData, null, 2)}

      Identify and categorize the changes into:
      1. Critical Changes: Changes that require immediate attention (e.g., departure dates, ports, cargo)
      2. Minor Changes: Updates that are informational (e.g., contact details, minor descriptions)
      3. New Information: Data that wasn't available before
      4. Conflicts: Discrepancies that need resolution

      Return a structured JSON object with these categories and specific change details.`;

    console.log('OpenAI prompt:', prompt);

    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OpenAI API key not configured');
    } 

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are a logistics data analysis expert. Analyze changes and return structured JSON only.'
        },
        {
          role: 'user', 
          content: prompt
        }
      ],
      temperature: 0.1,
      max_tokens: 1500
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
    const changesAnalysis = JSON.parse(cleanedContent);
    return changesAnalysis;

  } catch (error) {
    console.error('Error analyzing changes with OpenAI:', error);
    return {
      error: 'Failed to analyze changes',
      details: error instanceof Error ? error.message : String(error)
    };
  }
}