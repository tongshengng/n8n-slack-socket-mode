import { App } from '@slack/bolt';
import type {
	IDataObject,
	ILoadOptionsFunctions,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	ITriggerFunctions,
	ITriggerResponse,
	NodeConnectionType,
} from 'n8n-workflow';

type SlackCredential = {
	botToken: string;
	appToken: string;
	signingSecret: string;
};

interface SlackChannel {
	id?: string;
	name?: string;
	[key: string]: unknown;
}

interface SlackEventData {
	text?: string;
	channel?: string;
	user?: string;
	ts?: string;
	subtype?: string;
	reactionItem?: {
		channel?: string;
	};
	[key: string]: unknown;
}

interface Subscriber {
	triggerEvents: string[];
	watchedChannelIds: string[];
	messageFilterPattern?: string;
	shouldAllowBotMessages?: boolean;
	nodeId: string;
	workflowId?: string;
	botToken: string;
	emit: (data: IDataObject) => void;
}

let subscribers: Subscriber[] = [];
const regexCache = new Map<string, RegExp>();

const getCachedRegex = (pattern: string): RegExp | null => {
	if (regexCache.has(pattern)) {
		return regexCache.get(pattern) || null;
	}

	try {
		const regex = new RegExp(pattern, 'i');
		regexCache.set(pattern, regex);
		return regex;
	} catch (error) {
		console.error('Invalid regex pattern:', pattern, error);
		return null;
	}
};

const cleanupUnusedSlackConnections = async (
	logger?: Pick<ITriggerFunctions['logger'], 'info' | 'error'>,
) => {
	const activeBotTokens = new Set(subscribers.map((subscriber) => subscriber.botToken));
	const activeApps = SlackSocketConnectionManager.getActiveSlackApps();

	for (const slackApp of activeApps) {
		if (!activeBotTokens.has(slackApp.botToken)) {
			try {
				await SlackSocketConnectionManager.stopSlackSocketConnection(slackApp.botToken);
			} catch (error) {
				if (logger) {
					logger.error(`Error stopping unused Slack app: ${error}`);
				}
			}
		}
	}
};

namespace SlackSocketConnectionManager {
	const activeSlackApps: {
		stop: () => Promise<void>;
		botToken: string;
	}[] = [];

	export function getActiveSlackApps() {
		return activeSlackApps;
	}

	export async function startSlackSocketConnection(credentials: SlackCredential) {
		if (activeSlackApps.find((slackApp) => slackApp.botToken === credentials.botToken)) {
			return Promise.resolve();
		}

		const slackApp = new App({
			token: credentials.botToken,
			signingSecret: credentials.signingSecret,
			appToken: credentials.appToken,
			socketMode: true,
		});

		activeSlackApps.push({
			stop: async () => {
				await slackApp.stop();
			},
			botToken: credentials.botToken,
		});

		// Helper function to check if subscriber should process event
		const shouldProcessEvent = (
			subscriber: Subscriber,
			eventType: string,
			slackEventData: SlackEventData,
		): boolean => {
			// Check if subscriber listens to this event type
			if (!subscriber.triggerEvents.includes(eventType)) {
				return false;
			}

			// Skip bot messages for message events (unless allowed)
			if (eventType === 'message' && !subscriber.shouldAllowBotMessages) {
				if (
					slackEventData.subtype === 'bot_message' ||
					slackEventData.subtype === 'message_changed'
				) {
					return false;
				}
			}

			// Check channel filtering
			if (subscriber.watchedChannelIds.length > 0) {
				const targetChannelId =
					eventType === 'reaction_added'
						? slackEventData.reactionItem?.channel
						: slackEventData.channel;

				if (!targetChannelId || !subscriber.watchedChannelIds.includes(targetChannelId)) {
					return false;
				}
			}

			// Apply message filter for message events
			if (eventType === 'message' && subscriber.messageFilterPattern?.trim()) {
				const messageFilterRegex = getCachedRegex(subscriber.messageFilterPattern);
				if (!messageFilterRegex) {
					return false; // Invalid regex pattern
				}

				const messageText = slackEventData.text || '';
				if (!messageFilterRegex.test(messageText)) {
					return false;
				}
			}

			return true;
		};

		// Generic event handler function
		const handleSlackEvent = (eventType: string) => {
			return async ({
				body,
				payload,
				context,
				event,
			}: {
				body: unknown;
				payload: unknown;
				context: unknown;
				event: unknown;
			}) => {
				const slackEventData = event as SlackEventData;

				try {
					for (const subscriber of subscribers) {
						if (!shouldProcessEvent(subscriber, eventType, slackEventData)) {
							continue;
						}

						try {
							subscriber.emit({
								body: body as IDataObject,
								payload: payload as IDataObject,
								context: context as IDataObject,
								event: slackEventData as IDataObject,
							});
						} catch (error) {
							console.error(`Error emitting ${eventType} event to subscriber:`, error);
						}
					}
				} catch (error) {
					console.error(`Error handling Slack ${eventType} event:`, error);
				}
			};
		};

		// Register event handlers
		slackApp.event('message', handleSlackEvent('message'));
		slackApp.event('app_mention', handleSlackEvent('app_mention'));
		slackApp.event('reaction_added', handleSlackEvent('reaction_added'));

		await slackApp.start();
	}

	export async function stopSlackSocketConnection(botToken: string) {
		const slackApp = activeSlackApps.find((app) => app.botToken === botToken);
		if (slackApp) {
			await slackApp.stop();
			const appIndex = activeSlackApps.findIndex((app) => app.botToken === botToken);
			if (appIndex > -1) {
				activeSlackApps.splice(appIndex, 1);
			}
		}
	}
}

export class SlackSocketTrigger implements INodeType {
	methods = {
		loadOptions: {
			getChannels: async function (this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				try {
					const credentials = (await this.getCredentials(
						'slackSocketModeCredential',
					)) as SlackCredential;

					const slackApiClient = new App({
						token: credentials.botToken,
						signingSecret: credentials.signingSecret,
						appToken: credentials.appToken,
						socketMode: false, // Just for API calls
					});

					const channelsResponse = await slackApiClient.client.conversations.list({
						types: 'public_channel,private_channel',
						limit: 200,
					});

					const availableChannels = channelsResponse.channels || [];
					return (availableChannels as SlackChannel[]).map((channel) => ({
						name: `#${channel.name || 'unknown'}`,
						value: channel.id || '',
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
		outputs: ['main' as NodeConnectionType],
		credentials: [
			{
				name: 'slackSocketModeCredential',
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
					'Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
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
		const credentials = (await this.getCredentials('slackSocketModeCredential')) as SlackCredential;
		const triggerEvents = this.getNodeParameter('trigger', []) as string[];
		const watchedChannelIds = this.getNodeParameter('channelsToWatch', []) as string[];
		const messageFilterPattern = this.getNodeParameter('messageFilter', '') as string;
		const shouldAllowBotMessages = this.getNodeParameter('allowBotMessages', false) as boolean;

		if (!triggerEvents || triggerEvents.length === 0) {
			throw new Error('At least one trigger event must be selected');
		}

		if (!subscribers.some((subscriber) => subscriber.nodeId === this.getNode().id)) {
			subscribers.push({
				workflowId: this.getWorkflow().id,
				nodeId: this.getNode().id,
				triggerEvents: triggerEvents,
				watchedChannelIds: watchedChannelIds,
				messageFilterPattern: messageFilterPattern,
				shouldAllowBotMessages: shouldAllowBotMessages,
				botToken: credentials.botToken,
				emit: (data) => this.emit([this.helpers.returnJsonArray(data)]),
			});
		}

		await cleanupUnusedSlackConnections(this.logger);

		const manualTriggerFunction = async () => {
			try {
				await SlackSocketConnectionManager.startSlackSocketConnection(credentials);
				this.logger.info('Started Slack Socket app in test mode');
			} catch (error) {
				this.logger.error(`Error starting Slack Socket app in test mode: ${error}`);
				throw error;
			}
		};

		if (this.getMode() === 'trigger') {
			try {
				await SlackSocketConnectionManager.startSlackSocketConnection(credentials);
				this.logger.info('Started Slack Socket app in trigger mode');
			} catch (error) {
				this.logger.error(`Error starting Slack Socket app in trigger mode: ${error}`);
				throw error;
			}
		}

		return {
			manualTriggerFunction,
			closeFunction: async () => {
				subscribers = subscribers.filter((subscriber) => subscriber.nodeId !== this.getNode().id);
				await cleanupUnusedSlackConnections(this.logger);
			},
		};
	}
}
