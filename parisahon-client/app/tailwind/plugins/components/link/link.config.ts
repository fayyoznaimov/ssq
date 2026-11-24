export const key = 'link' as const;

export const defaultConfig = {
    font: {
        family: 'sans',
        color: {
            hover: {
                light: 'primary-500',
                dark: 'primary-200',
            },
            focus: {
                light: 'primary-500',
                dark: 'primary-200',
            },
        },
    },
};

export type LinkPluginConfig = typeof defaultConfig
export interface LinkPluginConfigPartial {
  [key]: LinkPluginConfig
}
