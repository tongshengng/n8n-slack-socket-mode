import {
	IDataObject,
	ILoadOptionsFunctions,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	ITriggerFunctions,
	ITriggerResponse,
	NodeConnectionType,
} from 'n8n-workflow';
import { App } from '@slack/bolt';

type SlackCredential = {
	botToken: string;
	appToken: string;
	signingSecret: string;
};

interface Subscriber {
	trigger: string[];
	channelsToWatch: string[];
	messageFilter?: string;
	allowBotMessages?: boolean;
	nodeId: string;
	workflowId?: string;
	botToken: string;
	emit: (data: IDataObject) => void;
}

let subscribers: Subscriber[] = [];

class SlackSocketConnectors {
	static apps: {
		stop: () => Promise<void>;
		botToken: string;
	}[] = [];

	static async start(credentials: SlackCredential) {
		if (this.apps.find((app) => app.botToken === credentials.botToken)) {
			return Promise.resolve();
		}

		const app = new App({
			token: credentials.botToken,
			signingSecret: credentials.signingSecret,
			appToken: credentials.appToken,
			socketMode: true,
		});

		this.apps.push({
			stop: async () => {
				await app.stop();
			},
			botToken: credentials.botToken,
		});

		// Generic event handler function
		const handleSlackEvent = (eventType: string) => {
			return async ({ body, payload, context, event }: any) => {
				try {
					subscribers.forEach((subscriber) => {
						// Skip bot messages and message updates for message events (unless allowed)
						if (
							eventType === 'message' &&
							!subscriber.allowBotMessages &&
							(event.subtype === 'bot_message' || event.subtype === 'message_changed')
						) {
							return;
						}
						if (!subscriber.trigger.includes(eventType)) {
							return;
						}

						// Get the channel ID based on event type
						const channelId = eventType === 'reaction_added' ? event.item.channel : event.channel;

						// Check if channel should be watched
						if (
							subscriber.channelsToWatch.length > 0 &&
							!subscriber.channelsToWatch.includes(channelId)
						) {
							return;
						}

						// Apply message filter for message events
						if (
							eventType === 'message' &&
							subscriber.messageFilter &&
							subscriber.messageFilter.trim() !== ''
						) {
							try {
								const regex = new RegExp(subscriber.messageFilter, 'i');
								const messageText = (event as any).text || '';
								if (!regex.test(messageText)) {
									return; // Skip if message doesn't match filter
								}
							} catch (regexError) {
								console.error('Invalid regex pattern in message filter:', regexError);
								return; // Skip if regex is invalid
							}
						}

						try {
							subscriber.emit({ body, payload, context, event });
						} catch (error) {
							console.error(`Error emitting ${eventType} event to subscriber:`, error);
						}
					});
				} catch (error) {
					console.error(`Error handling Slack ${eventType} event:`, error);
				}
			};
		};

		// Register event handlers
		app.event('message', handleSlackEvent('message'));
		app.event('app_mention', handleSlackEvent('app_mention'));
		app.event('reaction_added', handleSlackEvent('reaction_added'));

		await app.start();
	}

	static async stop(botToken: string) {
		const app = this.apps.find((app) => app.botToken === botToken);

		if (app) {
			await app.stop();
			this.apps = this.apps.filter((app) => app.botToken !== botToken);
		}
	}
}

export class SlackSocketTrigger implements INodeType {
	methods = {
		loadOptions: {
			getChannels: async function (this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				try {
					const credentials = (await this.getCredentials(
						'slackSocketCredentialsApi',
					)) as SlackCredential;
					const app = new App({
						token: credentials.botToken,
						signingSecret: credentials.signingSecret,
						appToken: credentials.appToken,
						socketMode: false, // Just for API calls
					});

					const result = await app.client.conversations.list({
						types: 'public_channel,private_channel',
						limit: 200,
					});

					const channels = result.channels || [];
					return channels.map((channel: any) => ({
						name: `#${channel.name}`,
						value: channel.id,
					}));
				} catch (error) {
					this.logger.error('Error fetching channels:', error);
					return [];
				}
			},
		},
	};

	description: INodeTypeDescription = {
		displayName: 'Slack Socket Mode Trigger',
		name: 'slackSocketTrigger',
		group: ['trigger'],
		version: 1,
		description: 'Triggers workflow when a Slack message matches a regex pattern via Socket Mode',
		defaults: {
			name: 'Slack Socket Mode Trigger',
		},
		icon: 'file:./assets/slack-socket-mode.svg',
		inputs: [],
		outputs: [NodeConnectionType.Main],
		credentials: [
			{
				name: 'slackSocketCredentialsApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Trigger On',
				name: 'trigger',
				type: 'multiOptions',
				options: [
					{
						name: 'Message',
						value: 'message',
						description: 'When a message was sent to a channel',
					},
					{
						name: 'App Mention',
						value: 'app_mention',
						description: 'When the app is mentioned in a message',
					},
					{
						name: 'Reaction Added',
						value: 'reaction_added',
						description: 'When a reaction is added to a message',
					},
				],
				default: ['message'],
				required: true,
			},
			{
				displayName: 'Channels to Watch',
				name: 'channelsToWatch',
				type: 'multiOptions',
				default: [],
				placeholder: 'Select channels',
				description:
					'Select channels to filter events. If none specified, events from all channels will trigger the workflow.',
				typeOptions: {
					loadOptionsMethod: 'getChannels',
				},
			},
			{
				displayName: 'Message Filter (Optional)',
				name: 'messageFilter',
				type: 'string',
				default: '',
				placeholder: 'Enter regex pattern or leave empty for all messages',
				description:
					'Optional regex pattern to filter messages. Only messages matching this pattern will trigger the workflow.',
				displayOptions: {
					show: {
						trigger: ['message'],
					},
				},
			},
			{
				displayName: 'Allow Bot Messages',
				name: 'allowBotMessages',
				type: 'boolean',
				default: false,
				description:
					'Whether to include messages from bots. By default, bot messages and message updates are filtered out.',
				displayOptions: {
					show: {
						trigger: ['message'],
					},
				},
			},
		],
	};

	async trigger(this: ITriggerFunctions): Promise<ITriggerResponse> {
		const credentials = (await this.getCredentials('slackSocketCredentialsApi')) as SlackCredential;
		const trigger = this.getNodeParameter('trigger', []) as string[];
		const channelsToWatch = this.getNodeParameter('channelsToWatch', []) as string[];
		const messageFilter = this.getNodeParameter('messageFilter', '') as string;
		const allowBotMessages = this.getNodeParameter('allowBotMessages', false) as boolean;

		if (!trigger || trigger.length === 0) {
			throw new Error('At least one trigger event must be selected');
		}

		if (!subscribers.some((subscriber) => subscriber.nodeId === this.getNode().id)) {
			subscribers.push({
				workflowId: this.getWorkflow().id,
				nodeId: this.getNode().id,
				trigger,
				channelsToWatch,
				messageFilter: messageFilter,
				allowBotMessages: allowBotMessages,
				botToken: credentials.botToken,
				emit: (data) => this.emit([this.helpers.returnJsonArray(data)]),
			});
		}

		for (const app of SlackSocketConnectors.apps) {
			const activeBotTokens = subscribers.map((subscriber) => subscriber.botToken);
			if (!activeBotTokens.includes(app.botToken)) {
				try {
					await SlackSocketConnectors.stop(app.botToken);
				} catch (error) {
					this.logger.error(`Error stopping unused Slack app: ${error}`);
				}
			}
		}

		const manualTriggerFunction = async () => {
			try {
				await SlackSocketConnectors.start(credentials);
				this.logger.info('Started Slack Socket app in test mode');
			} catch (error) {
				this.logger.error('Error starting Slack Socket app in test mode: ' + error);
				throw error;
			}

			return new Promise<void>((resolve) => {
				resolve();
			});
		};

		if (this.getMode() === 'trigger') {
			try {
				await SlackSocketConnectors.start(credentials);
				this.logger.info('Started Slack Socket app in trigger mode');
			} catch (error) {
				this.logger.error('Error starting Slack Socket app in trigger mode: ' + error);
				throw error;
			}
		}

		return {
			manualTriggerFunction,
			closeFunction: async () => {
				subscribers = subscribers.filter((subscriber) => subscriber.nodeId !== this.getNode().id);
				const subscribersBotTokens = subscribers.map((subscriber) => subscriber.botToken);

				for (const app of SlackSocketConnectors.apps) {
					if (!subscribersBotTokens.includes(app.botToken)) {
						try {
							await SlackSocketConnectors.stop(app.botToken);
						} catch (error) {
							this.logger.error('Error stopping Slack app during cleanup:', error);
						}
					}
				}
			},
		};
	}
}
