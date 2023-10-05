import { AppConfigurationClient } from "@azure/app-configuration";
import { ConfigManager, ConfigManagerBuilder } from "./configuration-manager";

describe('config manager tests', () => {
    let configManager: ConfigManager;
    let appConfigClientMock: Partial<AppConfigurationClient>;
    let loggerMock: Partial<Console>;
    beforeEach(() => {
        appConfigClientMock = {
            listConfigurationSettings: jest.fn(),
            getConfigurationSetting: jest.fn()
        };

        loggerMock = {
            debug: jest.fn(),
            warn: jest.fn(),
        };
    });
    it('should register config manager with filters and pull configuration once', async () => {
        // given
        (appConfigClientMock.listConfigurationSettings as jest.Mock).mockReturnValueOnce({
            next: jest.fn()
                .mockResolvedValueOnce({
                    done: false,
                    value: {
                        key: 'key',
                        value: '{"something": true}',
                    }
                })
                .mockResolvedValueOnce({
                    done: true,
                    value: undefined
                })
        });

        configManager = await ConfigManagerBuilder.createConfigManager(appConfigClientMock as AppConfigurationClient)
            .setFilters([{
                keyFilter: 'key',
                labelFilter: 'label'
            }])
            .start('manager-name');

        // then
        expect(configManager.getConfigurations()).toEqual([{ key: 'key', value: { something: true } }]);
    });

    it('should register config manager with filters and polling and activate polling after time passed', async () => {
        // given
        jest.useFakeTimers();
        (appConfigClientMock.listConfigurationSettings as jest.Mock)
            .mockReturnValue({
                next: jest.fn()
                    .mockResolvedValueOnce({
                        done: false,
                        value: {
                            key: 'key',
                            value: '{"something": true}',
                        }
                    })
                    .mockResolvedValueOnce({
                        done: true,
                        value: undefined
                    })
                    .mockResolvedValueOnce({
                        done: false,
                        value: {
                            key: 'key',
                            value: '{"something": true}',
                        }
                    })
                    .mockResolvedValueOnce({
                        done: true,
                        value: undefined
                    })
            });

        configManager = await ConfigManagerBuilder.createConfigManager(appConfigClientMock as AppConfigurationClient)
            .setFilters([{
                keyFilter: 'key',
                labelFilter: 'label'
            }])
            .setPoolingInterval(10000)
            .start('manager-name');

        // when
        jest.runAllTimers();

        // then
        expect(appConfigClientMock.listConfigurationSettings).toHaveBeenCalledTimes(2);
    });

    it('should log correct messages', async () => {
        // given

        (appConfigClientMock.listConfigurationSettings as jest.Mock).mockReturnValueOnce({
            next: jest.fn()
                .mockResolvedValueOnce({
                    done: false,
                    value: {
                        key: 'key',
                        value: '{"something": true}',
                    }
                })
                .mockResolvedValueOnce({
                    done: true,
                    value: undefined
                })
        });

        configManager = await ConfigManagerBuilder.createConfigManager(appConfigClientMock as AppConfigurationClient)
            .setFilters([{
                keyFilter: 'key',
                labelFilter: 'label'
            }])
            .setLogger(loggerMock as Console)
            .start('manager-name');

        // then
        expect(loggerMock.debug).toHaveBeenCalledWith('manager-name: initializing configuration manager');
        expect(loggerMock.debug).toHaveBeenCalledWith('manager-name: starting to update configurations');
        expect(loggerMock.debug).toHaveBeenCalledWith('manager-name: finished updating configurations with 1 values');
    });

    it('should pull configurations only once if sentinel key returns the same results', async () => {
        // given
        jest.useFakeTimers();
        (appConfigClientMock.listConfigurationSettings as jest.Mock)
            .mockReturnValue({
                next: jest.fn()
                    .mockResolvedValueOnce({
                        done: false,
                        value: {
                            key: 'key',
                            value: '{"something": true}',
                        }
                    })
                    .mockResolvedValueOnce({
                        done: true,
                        value: undefined
                    })
                    .mockResolvedValueOnce({
                        done: false,
                        value: {
                            key: 'key',
                            value: '{"something": true}',
                        }
                    })
                    .mockResolvedValueOnce({
                        done: true,
                        value: undefined
                    })
            });

        (appConfigClientMock.getConfigurationSetting as jest.Mock).mockResolvedValue({
            key: 'key',
            value: 1
        });

        configManager = await ConfigManagerBuilder.createConfigManager(appConfigClientMock as AppConfigurationClient)
            .setFilters([{
                keyFilter: 'key',
                labelFilter: 'label'
            }])
            .setSentinelConfigKey({ key: 'key', label: 'label' })
            .setPoolingInterval(10000)
            .start('manager-name');

        // when
        jest.runAllTimers();

        // then
        expect(appConfigClientMock.listConfigurationSettings).toHaveBeenCalledTimes(1);
    });

    it('should write warning if sentinel key hasn\'t been found', async () => {
        // given
        jest.useFakeTimers();
        (appConfigClientMock.listConfigurationSettings as jest.Mock)
            .mockReturnValue({
                next: jest.fn()
                    .mockResolvedValueOnce({
                        done: false,
                        value: {
                            key: 'key',
                            value: '{"something": true}',
                        }
                    })
                    .mockResolvedValueOnce({
                        done: true,
                        value: undefined
                    })
                    .mockResolvedValueOnce({
                        done: false,
                        value: {
                            key: 'key',
                            value: '{"something": true}',
                        }
                    })
                    .mockResolvedValueOnce({
                        done: true,
                        value: undefined
                    })
            });

        (appConfigClientMock.getConfigurationSetting as jest.Mock).mockRejectedValue({
            statusCode: 404
        });

        configManager = await ConfigManagerBuilder.createConfigManager(appConfigClientMock as AppConfigurationClient)
            .setFilters([{
                keyFilter: 'key',
                labelFilter: 'label'
            }])
            .setLogger(loggerMock as Console)
            .setSentinelConfigKey({ key: 'key', label: 'label' })
            .setPoolingInterval(10000)
            .start('manager-name');

        // when
        jest.runAllTimers();

        // then
        expect(loggerMock.warn)
            .toHaveBeenCalledWith('manager-name: sentinel configuration was declared but not found on config server, skipping configurations update');
    });

    it('should call onConfigChange if it was declared', async () => {
        // given
        const onConfigChange = jest.fn();
         (appConfigClientMock.listConfigurationSettings as jest.Mock).mockReturnValueOnce({
            next: jest.fn()
                .mockResolvedValueOnce({
                    done: false,
                    value: {
                        key: 'key',
                        value: '{"something": true}',
                    }
                })
                .mockResolvedValueOnce({
                    done: true,
                    value: undefined
                })
        });

        configManager = await ConfigManagerBuilder.createConfigManager(appConfigClientMock as AppConfigurationClient)
            .setFilters([{
                keyFilter: 'key',
                labelFilter: 'label'
            }])
            .setOnUpdateListener(onConfigChange)
            .start('manager-name');

        // then
        expect(onConfigChange).toHaveBeenCalledWith([{key: 'key', value: {'something': true}}]);
    });
});
