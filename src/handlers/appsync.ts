interface CreateAgentMessageInput {
  pid: string;
  datetime: string;
  message: string;
  toolcall: boolean;
}

interface AppSyncResponse {
  data?: {
    createCargosynqDevAgentMessages: {
      datetime: string;
      pid: string;
      message: string;
      toolcall: boolean;
    };
  };
  errors?: Array<{
    message: string;
    [key: string]: any;
  }>;
}

export async function createCargosynqDevAgentMessages(input: CreateAgentMessageInput): Promise<any> {
  const mutation = `mutation createCargosynqDevAgentMessages($createcargosynqdevagentmessagesinput: CreateCargosynqDevAgentMessagesInput!) {
    createCargosynqDevAgentMessages(input: $createcargosynqdevagentmessagesinput) {
      datetime
      pid
      message
      toolcall
    }
  }`;

  const variables = {
    createcargosynqdevagentmessagesinput: input
  };

  const response = await fetch(process.env.APPSYNC_API_URL!, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.APPSYNC_API_KEY!
    },
    body: JSON.stringify({
      query: mutation,
      variables
    })
  });

  if (!response.ok) {
    throw new Error(`AppSync request failed: ${response.status} ${response.statusText}`);
  }

  const result: AppSyncResponse = await response.json();
  
  if (result.errors) {
    throw new Error('AppSync mutation error: ' + JSON.stringify(result.errors));
  }

  return result.data?.createCargosynqDevAgentMessages;
}