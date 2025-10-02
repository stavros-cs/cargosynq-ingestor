import { SQSEvent, SQSHandler } from 'aws-lambda';
import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { Resource } from 'sst';
import { createCargosynqDevAgentMessages } from './appsync';

const dynamodb = new DynamoDBClient({});

interface OpenAIResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}



// Function to call OpenAI API for email summarization
async function generateEmailSummary(emailContent: string): Promise<string> {
  const openaiApiKey = process.env.OPENAI_API_KEY;
  
  if (!openaiApiKey) {
    throw new Error('OpenAI API key not configured');
  }

  const prompt = `Please provide a concise summary of the following email content. 
  Data will be stored on dynamo DB through graphQL API. 
  So avoid using special characters or asterisks. Stick to alphanumeric characters and basic punctuation.
  Provide in summary the sender email address. Start the summaery like this "Email from [sender email]: ...".

  Focus on:
    - Main purpose/request
    - Key information
    - Important dates, amounts, or references
    - Action items if any

  Email content:
  ${emailContent}

  Summary:`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ],
        max_tokens: 200,
        temperature: 0.3,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
    }

    const data: OpenAIResponse = await response.json();
    return data.choices[0]?.message?.content?.trim() || 'Unable to generate summary';
  } catch (error) {
    console.error('OpenAI API call failed:', error);
    throw error;
  }
}

export const handler: SQSHandler = async (event: SQSEvent) => {
  console.log('Processing SQS ## events from EventBridge for email summarization:', JSON.stringify(event, null, 2));

  for (const sqsRecord of event.Records) {
    try {
      // Parse the SQS message body (contains EventBridge event)
      const eventBridgeEvent = JSON.parse(sqsRecord.body);
      console.log('EventBridge Event:', JSON.stringify(eventBridgeEvent, null, 2));
      const dynamoStreamRecord = eventBridgeEvent.detail;
      console.log('DynamoDB Stream Record:', JSON.stringify(dynamoStreamRecord, null, 2));

      // Check if this is an INSERT event
      if (dynamoStreamRecord.eventName !== 'INSERT') {
        console.log(`Skipping non-INSERT event: ${dynamoStreamRecord.eventName}`);
        continue;
      }

      const newImage = dynamoStreamRecord.dynamodb?.NewImage;
      if (!newImage) {
        console.log('No NewImage in DynamoDB record, skipping');
        continue;
      }

      // Check if this is an EML record
      const fileType = newImage.fileType?.S;
      if (fileType !== 'eml') {
        console.log(`Skipping non-EML record: ${fileType}`);
        continue;
      }

      const sessionId = newImage.sessionId?.S;
      const recordId = newImage.id?.S;
      const subject = newImage.subject?.S || '';
      const bodyText = newImage.bodyText?.S || '';
      const from = newImage.from?.S || '';

      if (!sessionId || !recordId) {
        console.error('Missing sessionId or id in DynamoDB record');
        continue;
      }

      console.log(`Generating summary for EML record: ${recordId} (session: ${sessionId})`);

      // Prepare email content for summarization
      const emailContent = `Subject: ${subject}
      From: ${from}

      ${bodyText}`;

      // Generate AI summary
      let summary: string;
      try {
        summary = await generateEmailSummary(emailContent);
        console.log(`Generated summary for ${recordId}: ${summary.substring(0, 100)}...`);
      } catch (error) {
        console.error(`Failed to generate summary for ${recordId}:`, error);
        summary = 'Summary generation failed - AI service unavailable';
      }

      // Update the DynamoDB record with the generated summary
      const updateCommand = new UpdateItemCommand({
        TableName: Resource.CargosynqIngestorRecords.name,
        Key: {
          sessionId: { S: sessionId },
          id: { S: recordId },
        },
        UpdateExpression: 'SET aiSummary = :summary, summaryGeneratedAt = :timestamp',
        ExpressionAttributeValues: {
          ':summary': { S: summary },
          ':timestamp': { S: new Date().toISOString() },
        },
      });

      const pid = "02-10-2025-0028#1";
      const hasToolCalls = false;
      
      // Sanitize message content for AppSync
      /*let sanitizedMessage = summary || '';
      
      // Remove or replace potentially problematic characters
      sanitizedMessage = sanitizedMessage
        .replace(/[\x00-\x1F\x7F-\x9F]/g, '') // Remove control characters
        .replace(/"/g, '\\"') // Escape quotes
        .trim();*/
      
      //console.log(sanitizedMessage);
      // Limit message length if needed (adjust as per your schema requirements)
      /*const maxLength = 500; // Adjust based on your GraphQL schema
      if (sanitizedMessage.length > maxLength) {
        sanitizedMessage = sanitizedMessage.substring(0, maxLength) + '...';
      }*/
      
      const  graphQLmessage =  {
        "content": summary,
        "role": "user"
      };

      // Save to agent messages table via AppSync
      try {
        const input = {
          pid,
          datetime: new Date().toISOString(),
          message: JSON.stringify(graphQLmessage),
          toolcall: hasToolCalls
        };
        console.log('Saving to AppSync with input:', {
          ...input
        });
        await createCargosynqDevAgentMessages(input);
        console.log('Saved AI summary to agent messages table');
      } catch (err) {
        console.error('Error saving AI summary to agent messages table:', err);
        console.error('Input that caused error:', {
          pid,
          datetime: new Date().toISOString(),
          message: sanitizedMessage,
          toolcall: hasToolCalls
        });
        // Continue processing even if AppSync save fails
      }
     

      await dynamodb.send(updateCommand);
      console.log(`Updated EML record ${recordId} with AI summary`);

    } catch (error) {
      console.error('Failed to process email for summarization:', error);
      // Continue processing other records even if one fails
    }
  }
};