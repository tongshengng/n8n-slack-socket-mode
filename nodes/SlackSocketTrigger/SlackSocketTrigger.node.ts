import {
	IDataObject,
	INodeType,
	INodeTypeDescription,
	ITriggerFunctions,
	ITriggerResponse,
	NodeConnectionType,
} from 'n8n-workflow';
import { App } from '@slack/bolt';

interface SlackCredential {
	botToken: string;
	appToken: string;
	signingSecret: string;
}

const subscibers: {
	trigger: string[];
	channelToWatch: string;
	workflowId: string;
	botToken: string;
	emit: (data: IDataObject) => void;
}[] = [];

class SlackSocketConnectors {
	static apps: (App & {
		botToken: string;
	})[] = [];

	static async start(credentials: SlackCredential) {
		credentials.botToken;
		if (this.apps.find((app) => app.botToken === credentials.botToken)) {
			return Promise.resolve();
		}

		const app = new App({
			token: credentials.botToken,
			signingSecret: credentials.signingSecret,
			appToken: credentials.appToken,
			socketMode: true,
		});

		this.apps.push(app as App & { botToken: string });

		app.event('message', async ({ body, payload, context, event }) => {
			if (event.subtype === 'bot_message') {
				return Promise.resolve();
			}

			subscibers.forEach((subscriber) => {
				if (subscriber.trigger.includes('message') && subscriber.channelToWatch === event.channel) {
					subscriber.emit({ body, payload, context, event });
				}
			});

			return Promise.resolve();
		});

		await app.start();
	}

	static async stop(credentials: SlackCredential) {
		const subscibersWithBotToken = subscibers.filter(
			(subscriber) => subscriber.botToken === credentials.botToken,
		);
		if (subscibersWithBotToken.length === 0) {
			const app = this.apps.find((app) => app.botToken === credentials.botToken);
			if (app) {
				await app.stop();

				this.apps = this.apps.filter((app) => app.botToken !== credentials.botToken);
			}
		}
	}
}

export class SlackSocketTrigger implements INodeType {
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
				],
				default: [],
			},
			{
				displayName: 'Channel to Watch',
				name: 'channelToWatch',
				type: 'resourceLocator',
				default: { mode: 'list', value: '' },
				placeholder: 'Select a channel',
				description:
					'Select a channel to filter events. If specified, only events from this channel will trigger the workflow.',
				modes: [
					{
						displayName: 'From List',
						name: 'list',
						type: 'list',
						placeholder: 'Select a channel',
						typeOptions: {
							searchListMethod: 'channelSearch',
							searchable: true,
						},
					},
					{
						displayName: 'By ID',
						name: 'id',
						type: 'string',
						placeholder: 'C1234567890',
						validation: [
							{
								type: 'regex',
								properties: {
									regex: '^[C|G|D][A-Z0-9]{8,}$',
									errorMessage: 'Not a valid Slack channel ID',
								},
							},
						],
					},
				],
			},
		],
	};

	async trigger(this: ITriggerFunctions): Promise<ITriggerResponse> {
		const credentials = (await this.getCredentials('slackSocketCredentialsApi')) as SlackCredential;
		const trigger = this.getNodeParameter('trigger', []) as string[];
		const channelToWatch = this.getNodeParameter('channelToWatch') as {
			mode: string;
			value: string;
		};

		credentials.botToken;

		const channelId = channelToWatch.value;

		subscibers.push({
			workflowId: this.getNode().id,
			trigger,
			channelToWatch: channelId,
			botToken: credentials.botToken,
			emit: (data) => this.emit([this.helpers.returnJsonArray(data)]),
		});

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
				subscibers.forEach((subscriber) => {
					if (subscriber.workflowId === this.getNode().id) {
						subscibers.splice(subscibers.indexOf(subscriber), 1);
					}
				});

				await SlackSocketConnectors.stop(credentials);
			},
		};
	}
}
