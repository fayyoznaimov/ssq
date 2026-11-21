import { useAbility } from '@casl/vue';

import { AppAbility } from '../utils/casl';

export const useAppAbility = () => useAbility<AppAbility>();