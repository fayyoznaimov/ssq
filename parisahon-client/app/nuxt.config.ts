import { fileURLToPath, URL } from "node:url";

import ckeditor5 from "@ckeditor/vite-plugin-ckeditor5";
import {createResolver} from "@nuxt/kit";
import colors from "tailwindcss/colors";

const {resolve} = createResolver(import.meta.url);

export default defineNuxtConfig({
    ssr: false,
    vite: {
        vue: {
            script: {
                defineModel: true,
                propsDestructure: true,
            },
        },
        plugins: [ckeditor5( { theme: require.resolve( "@ckeditor/ckeditor5-theme-lark" ) } )],
        define: {
            __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: false,
        },
        resolve: {
            alias: {
                "@": fileURLToPath( new URL( "./src", import.meta.url ) )
            }
        },
        server: {
            hmr: {
                clientPort: 4100,
            },
        },
    },
    app: {
        head: {
            title: "Houston",
            titleTemplate: "%s - Houston",
            meta: [
                {name: "viewport", content: "width=device-width, initial-scale=1"},
            ],
            link: [{rel: "icon", type: "image/x-icon", href: "/favicon.ico"}],
        },
        pageTransition: {
            enterActiveClass: "transition-opacity duration-200 ease-out",
            enterFromClass: "opacity-0",
            enterToClass: "opacity-100",
            leaveActiveClass: "transition-opacity duration-75 ease-in",
            leaveFromClass: "opacity-100",
            leaveToClass: "opacity-0"
        },
    },
    components: [
        {
            prefix: "",
            path: resolve("./components/base"),
            global: false,
        },
        {
            prefix: "",
            path: resolve("./components/icon"),
            global: false,
        },
        {
            prefix: "",
            path: resolve("./components/form"),
            global: false,
        },
    ],
    runtimeConfig: {
        public: {
            // Overridable via NUXT_PUBLIC_API_URL / NUXT_PUBLIC_SOCKET_URL (see ../../docker-compose.local.yml)
            apiUrl: "https://crm.parisahome.com/api/v1",
            socketUrl: "wss://crm.parisahome.com"
            // The Telegram application keys live in the API environment now (TELEGRAM_API_ID / TELEGRAM_API_HASH)
        }
    },
    modules: [
        "@pinia/nuxt",
        "@nuxtjs/tailwindcss",
        "@vueuse/nuxt",
        "@nuxtjs/color-mode",
        "nuxt-icon",
        "nuxt-permissions",
    ],
    tailwindcss: {
        exposeConfig: true,
        config: {
            theme: {
                container: {center: true},
                extend: {
                    colors: {
                        ...colors,
                        primary: {
                            200: "#08b09c",
                            300: "#068474",
                            400: "#04574d",
                            500: "#022b26",
                            600: "#022722",
                            700: "#02221e",
                            800: "#011e1b"
                        },
                        secondary: {
                            200: "#f4d1b0",
                            300: "#f2cba5",
                            400: "#f1c499",
                            500: "#efbe8e",
                            600: "#eaab6d",
                            700: "#e6984b",
                            800: "#e1842a"
                        }
                    },
                }
            }
        }
    },
    colorMode: {
        classSuffix: "",
    },
    typescript: {
        typeCheck: false
    },
});
