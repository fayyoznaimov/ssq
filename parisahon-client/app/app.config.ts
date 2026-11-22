export default defineAppConfig({
    pagination: {
        defaultPageSize: 25,
    },
    tairo: {
        collapse: {
            circularMenu: {
                enabled: false,
                tools: [],
            },
            toolbar: {
                enabled: true,
                showTitle: true,
                showNavBurger: true,
                tools: [],
            },
            navigation: {
                enabled: true,
                items: [
                    {
                        name: "Задачи",
                        icon: {
                            name: "fluent:tasks-app-20-regular",
                            class: "w-5 h-5"
                        },
                        to: "/tasks",
                        subject: "Task"
                    },
                    {
                        name: "Почта",
                        icon: {
                            name: "ph:envelope-simple",
                            class: "w-5 h-5"
                        },
                        to: "/mails",
                        subject: "Mail"
                    },
                    {
                        name: "Телеграм",
                        icon: {
                            name: "ph:telegram-logo",
                            class: "w-5 h-5"
                        },
                        to: "/telegram",
                        subject: "Telegram"
                    },
                    {
                        name: "WhatsApp",
                        icon: {
                            name: "ph:whatsapp-logo",
                            class: "w-5 h-5"
                        },
                        to: "/whatsapp",
                        subject: "WhatsApp"
                    },
                    {
                        name: "Аналитика",
                        icon: {
                            name: "ph:chart-line",
                            class: "w-5 h-5"
                        },
                        roles: ["admin", "manager"],
                        to: "/analytics",
                        subject: "Analytics",
                        children: [
                            {
                                name: "Анализ продаж",
                                icon: {
                                    name: "lucide:area-chart",
                                    class: "w-5 h-5"
                                },
                                to: "/analytics/sales",
                                subject: "Sales-Analytics"
                            },
                            {
                                name: "По менеджерам",
                                icon: {
                                    name: "clarity:employee-group-solid",
                                    class: "w-5 h-5"
                                },
                                to: "/analytics/managers",
                                subject: "Manager-Analytics"
                            },
                            {
                                name: "По сотрудникам",
                                icon: {
                                    name: "clarity:employee-group-solid",
                                    class: "w-5 h-5"
                                },
                                to: "/analytics/employees",
                                subject: "Employee-Analytics"
                            },
                            {
                                name: "По товарам",
                                icon: {
                                    name: "ph:rows",
                                    class: "w-5 h-5"
                                },
                                to: "/analytics/products",
                                subject: "Product-Analytics"
                            },
                            {
                                name: "Список событий",
                                icon: {
                                    name: "ph:arrows-left-right",
                                    class: "w-5 h-5"
                                },
                                to: "/analytics/events",
                                subject: "Event"
                            },
                            {
                                name: "Цели",
                                icon: {
                                    name: "ph:target",
                                    class: "w-5 h-5"
                                },
                                to: "/analytics/goals",
                                subject: "Goals"
                            },
                            {
                                name: "Сводный отчет",
                                icon: {
                                    name: "ph:files",
                                    class: "w-5 h-5"
                                },
                                to: "/analytics/consolidated",
                                subject: "Consolidated"
                            },
                            {
                                name: "Звонки",
                                icon: {
                                    name: "ph:phone",
                                    class: "w-5 h-5"
                                },
                                to: "/analytics/calls",
                                subject: "Calls"
                            },
                            {
                                name: "Контроль менеджеров",
                                icon: {
                                    name: "ph:gauge",
                                    class: "w-5 h-5"
                                },
                                to: "/analytics/control",
                                subject: "Control"
                            },
                        ]
                    },
                    {
                        name: "Списки",
                        icon: {
                            name: "ph:list",
                            class: "w-5 h-5"
                        },
                        to: "/lists",
                        subject: "List",
                        children: [
                            {
                                name: "Компании",
                                icon: {
                                    name: "ph:buildings",
                                    class: "w-5 h-5"
                                },
                                to: "/lists/companies",
                                subject: "Company"
                            },
                            {
                                name: "Контакты",
                                icon: {
                                    name: "ph:user-list",
                                    class: "w-5 h-5"
                                },
                                to: "/lists/contacts",
                                subject: "Contact"
                            },
                            {
                                name: "Записи звонков",
                                icon: {
                                    name: "ph:phone",
                                    class: "w-5 h-5"
                                },
                                to: "/lists/calls",
                                subject: "Call"
                            },
                            {
                                name: "Товары",
                                icon: {
                                    name: "ph:rows",
                                    class: "w-5 h-5"
                                },
                                to: "/lists/products",
                                subject: "Product"
                            },
                            {
                                name: "Файлы",
                                icon: {
                                    name: "ph:files",
                                    class: "w-5 h-5"
                                },
                                to: "/lists/files",
                                subject: "File"
                            },
                        ]
                    },
                    {
                        name: "Сделки",
                        icon: {
                            name: "ph:currency-circle-dollar",
                            class: "w-5 h-5"
                        },
                        to: "/deals",
                        subject: "Deal"
                    },
                    {
                        name: "Настройки",
                        icon: {
                            name: "ph:gear",
                            class: "w-5 h-5"
                        },
                        roles: ["admin"],
                        to: "/settings",
                        subject: "Settings",
                        children: [
                            {
                                name: "Пользователи",
                                icon: {
                                    name: "ph:users",
                                    class: "w-5 h-5"
                                },
                                to: "/settings/users",
                                subject: "User"
                            },
                            {
                                name: "Группы",
                                icon: {
                                    name: "ph:users-three",
                                    class: "w-5 h-5"
                                },
                                to: "/settings/groups",
                                subject: "Group"
                            },
                            {
                                name: "Транспортеры",
                                icon: {
                                    name: "ph:envelope-simple",
                                    class: "w-5 h-5"
                                },
                                to: "/settings/transporters",
                                subject: "Transporter"
                            },
                            {
                                name: "Подпись в письмах",
                                icon: {
                                    name: "ph:signature",
                                    class: "w-5 h-5"
                                },
                                to: "/settings/signature",
                                subject: "MailSignature"
                            },
                            {
                                name: "Запись звонков",
                                icon: {
                                    name: "ph:phone-incoming",
                                    class: "w-5 h-5"
                                },
                                to: "/settings/calls",
                                subject: "CallRecorder"
                            },
                        ],
                    },
                    {
                        name: "Divider",
                        divider: true,
                    },
                    {
                        name: "Выйти",
                        icon: { name: "ph:sign-out", class: "w-5 h-5" },
                        to: "/logout"
                    },
                ],
            },
        },
    },
    nui: {
        BaseAccordion: {
            rounded: "sm",
            action: "dot",
        },
        BaseAutocomplete: {
            rounded: "sm",
            size: "md",
            contrast: "default",
        },
        BaseAutocompleteItem: {
            rounded: "sm",
        },
        BaseAvatar: {
            size: "sm",
            rounded: "full",
        },
        BaseAvatarGroup: {
            limit: 4,
            size: "sm",
        },
        BaseButton: {
            variant: "solid",
            rounded: "sm",
            color: "default",
            size: "md",
        },
        BaseButtonAction: {
            rounded: "sm",
            color: "default",
        },
        BaseButtonClose: {
            rounded: "full",
        },
        BaseButtonIcon: {
            rounded: "sm",
            color: "default",
            size: "md",
        },
        BaseCard: {
            rounded: "sm",
            color: "white",
        },
        BaseCheckbox: {
            rounded: "sm",
            color: "default",
        },
        BaseCheckboxAnimated: {
            color: "primary",
        },
        BaseDropdown: {
            variant: "button",
            buttonColor: "default",
            color: "white",
            rounded: "sm",
            size: "md",
        },
        BaseDropdownItem: {
            rounded: "sm",
            color: "default",
        },
        BaseHeading: {
            as: "p",
            size: "xl",
            weight: "semibold",
            lead: "normal",
        },
        BaseIconBox: {
            variant: "solid",
            color: "default",
            size: "xs",
            rounded: "sm",
        },
        BaseInput: {
            rounded: "sm",
            size: "md",
            contrast: "default",
        },
        BaseInputFile: {
            rounded: "sm",
            size: "md",
            contrast: "default",
        },
        BaseInputNumber: {
            inputmode: "numeric",
            rounded: "sm",
            size: "md",
            contrast: "default",
        },
        BaseListbox: {
            rounded: "sm",
            size: "md",
            contrast: "default",
        },
        BaseMessage: {
            type: "success",
            rounded: "sm",
            closable: false,
        },
        BasePagination: {
            rounded: "sm",
        },
        BaseParagraph: {
            as: "p",
            size: "md",
            weight: "normal",
            lead: "normal",
        },
        BasePlaceholderPage: {
            imageSize: "xs",
        },
        BaseProgress: {
            size: "sm",
            contrast: "default",
            color: "primary",
            rounded: "full",
        },
        BaseProse: {
            rounded: "md",
        },
        BaseRadio: {
            color: "default",
        },
        BaseSelect: {
            rounded: "sm",
            size: "md",
            contrast: "default",
        },
        BaseSnack: {
            size: "md",
            color: "muted",
        },
        BaseSwitchBall: {
            color: "primary",
        },
        BaseSwitchThin: {
            color: "primary",
        },
        BaseTabs: {
            type: "tabs",
            justify: "start",
        },
        BaseTabSlider: {
            justify: "start",
            size: "md",
            rounded: "lg",
        },
        BaseTag: {
            variant: "solid",
            color: "default",
            size: "md",
            rounded: "lg",
        },
        BaseText: {
            size: "md",
            weight: "normal",
            lead: "normal",
        },
        BaseTextarea: {
            rounded: "sm",
            size: "md",
            contrast: "default",
        },
        BaseTreeSelectItem: {
            rounded: "sm",
        },
        defaultShapes: {
            accordion: "rounded",
            autocompleteItem: "rounded",
            avatar: "full",
            button: "rounded",
            buttonAction: "rounded",
            buttonIcon: "rounded",
            buttonClose: "full",
            card: "rounded",
            dropdown: "rounded",
            iconBox: "rounded",
            input: "rounded",
            message: "curved",
            pagination: "rounded",
            progress: "full",
            prose: "rounded",
            tabSlider: "rounded",
            tag: "rounded",
        },
    }
});
