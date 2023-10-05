import { AppConfigurationClient, ConfigurationSetting, FeatureFlagValue } from '@azure/app-configuration';
import { noop } from 'lodash';
export class ConfigManagerBuilder {
    private filters: ConfigFilter[] = [];
    private poolingIntervalInMS?: number;
    private sentinelConfigKey?: SentinelConfigKey;
    private logger?: ConfigurationManagerLogger;
    private onConfigUpdateListener?: OnConfigUpdateListener;

    private constructor(
        private readonly azureConfigClient: AppConfigurationClient,
    ) { }

    static createConfigManager(azureConfigClient: AppConfigurationClient): ConfigManagerBuilder {
        return new ConfigManagerBuilder(azureConfigClient);
    }

    setFilters(filters: ConfigFilter[]): ConfigManagerBuilder {
        this.filters = filters;
        return this;
    }

    setLogger(logger: ConfigurationManagerLogger): ConfigManagerBuilder {
        this.logger = logger;
        return this;
    }

    setPoolingInterval(intervalInMS: number): ConfigManagerBuilder {
        this.poolingIntervalInMS = intervalInMS;
        return this;
    }

    setSentinelConfigKey(sentinelConfigKey: SentinelConfigKey): ConfigManagerBuilder {
        this.sentinelConfigKey = sentinelConfigKey;
        return this;
    }

    setOnUpdateListener(listener: OnConfigUpdateListener): ConfigManagerBuilder {
        this.onConfigUpdateListener = listener;
        return this;
    }

    start(managerName:string): Promise<ConfigManager> {
        this.logger = {
            debug: (this.logger?.debug ?? noop).bind(this.logger),
            warn: (this.logger?.warn ?? noop).bind(this.logger),
            error: (this.logger?.error ?? noop).bind(this.logger),
            info: (this.logger?.info ?? noop).bind(this.logger),
        };

        return ConfigManagerImpl.create(
            {
                filters: this.filters,
                poolingIntervalInMS: this.poolingIntervalInMS,
                sentinelConfigKey: this.sentinelConfigKey,
                onConfigUpdateListener: this.onConfigUpdateListener,
                managerName
            },
            this.azureConfigClient,
            this.logger);
    }
}

class ConfigManagerImpl {
    private sentinelCurrentValue?: unknown;
    private configurationsOrFeatureFlags: ParsedConfigurationOrFeatureFlagEntry[] = [];

    static async create(configOptions: ConfigManagerOptions, azureConfigClient: AppConfigurationClient, logger: ConfigurationManagerLogger): Promise<ConfigManager> {
        const configManager = new ConfigManagerImpl(configOptions, azureConfigClient, logger);
        await configManager.start();

        return configManager;
    }

    private constructor(
        private readonly configOptions: ConfigManagerOptions,
        private readonly azureConfigClient: AppConfigurationClient,
        private readonly logger: ConfigurationManagerLogger
    ) {
        this.logger = this.loggerWrapper(logger);
     }

    getConfigurations(): ParsedConfigurationOrFeatureFlagEntry[] {
        return [...this.configurationsOrFeatureFlags];
    }

    private async start(): Promise<void> {
        this.logger.debug('initializing configuration manager');
        await this.updateConfigurations();

        if (this.configOptions.poolingIntervalInMS) {
            this.initializePoolingOnInterval();
        }
    }

    private async updateConfigurations(): Promise<void> {
        if (this.configOptions.sentinelConfigKey) {
            this.logger.debug('checking if configurations should be updated');
            this.logger.debug(`sentinel current value is ${this.sentinelCurrentValue}`);

            try {
                const sentinelConfig = await this.azureConfigClient.getConfigurationSetting(this.configOptions.sentinelConfigKey);
                if (this.sentinelCurrentValue === sentinelConfig.value) {
                    this.logger.debug('sentinel value did not change, skipping configurations update');
                    return;
                }

                this.logger.debug('sentinel value changed, updating configurations');
                this.sentinelCurrentValue = sentinelConfig.value;

            } catch (error) {
                const err = error as AzureConfigError;
                if (err.statusCode === 404) {
                    this.logger.warn('sentinel configuration was declared but not found on config server, skipping configurations update');
                    return;
                }
            }
        }
        // handle errors
        this.logger.debug('starting to update configurations');
        const promises = this.configOptions.filters
            .map(async filter => this.fetchConfigOrFeatureFlagByKeyAndLabel(filter.keyFilter, filter.labelFilter));

        this.configurationsOrFeatureFlags = (await Promise.all(promises)).flat();
        this.logger.debug(`finished updating configurations with ${this.configurationsOrFeatureFlags.length} values`);

        if (this.configOptions.onConfigUpdateListener) {
            this.logger.debug('firing onConfigUpdateListener with updated configurations');
            this.configOptions.onConfigUpdateListener(this.configurationsOrFeatureFlags);
        }
    }

    private initializePoolingOnInterval(): void {
        this.logger.debug(`configuration manager pooling initializing with ${this.configOptions.poolingIntervalInMS} interval`);
        setTimeout(async () => {
            await this.updateConfigurations();
            this.initializePoolingOnInterval();
        }, this.configOptions.poolingIntervalInMS);
    }

    private async fetchConfigOrFeatureFlagByKeyAndLabel(keyFilter: string, labelFilter: string): Promise<ParsedConfigurationOrFeatureFlagEntry[]> {
        const configIterator = this.azureConfigClient.listConfigurationSettings({
            keyFilter,
            labelFilter
        });

        const configurations: ParsedConfigurationOrFeatureFlagEntry[] = [];
        let config = await configIterator.next();
        while (!config.done) {
            const parsedConfigOrFeatureFlag = this.parseConfigValue(config.value);
            configurations.push(parsedConfigOrFeatureFlag);
            config = await configIterator.next();
        }

        return configurations;
    }

    private parseConfigValue(configSetting: ConfigurationSetting<string>): ParsedConfigurationOrFeatureFlagEntry {
        if (!configSetting.value) {
            return {
                key: configSetting.key,
                value: configSetting.value
            };
        }

        try {
            const value = JSON.parse(configSetting.value);
            return {
                key: configSetting.key,
                value
            };
        } catch (e) {
            return {
                key: configSetting.key,
                value: configSetting.value
            };
        }
    }

    private loggerWrapper(logger: ConfigurationManagerLogger): ConfigurationManagerLogger {
        return {
            debug: (message: string): void => {
                logger.debug(`${this.configOptions.managerName}: ${message}`);
            },
            error:(message: string): void => {
                logger.error(`${this.configOptions.managerName}: ${message}`);
            },
            info: (message: string): void => {
                logger.info(`${this.configOptions.managerName}: ${message}`);
            },
            warn: (message: string): void => {
                logger.warn(`${this.configOptions.managerName}: ${message}`);
            },
        };
    }

}

export type ConfigFilter = {
    keyFilter: string,
    labelFilter: string,
}

export type ConfigManagerOptions = {
    poolingIntervalInMS?: number,
    sentinelConfigKey?: SentinelConfigKey,
    filters: ConfigFilter[],
    onConfigUpdateListener?: OnConfigUpdateListener,
    managerName: string;
}

export type SentinelConfigKey = {
    key: string,
    label: string
}

export type ParsedConfigurationOrFeatureFlagEntry = {
    key: string,
    value?: unknown | string | FeatureFlagValue
};

type ConfigurationManagerLogger = {
    debug: typeof noop,
    error: typeof noop,
    info: typeof noop,
    warn: typeof noop,
}



type AzureConfigError = Error & {
    statusCode: number;
}

type OnConfigUpdateListener = (config: ParsedConfigurationOrFeatureFlagEntry[]) => void

export type ConfigManager = ConfigManagerImpl;