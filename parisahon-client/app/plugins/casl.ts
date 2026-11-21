import { abilitiesPlugin } from '@casl/vue';

import { ability } from '../utils/casl';

export default defineNuxtPlugin(nuxtApp => {
    nuxtApp.vueApp.use(abilitiesPlugin, ability, { useGlobalProperties: true });
});