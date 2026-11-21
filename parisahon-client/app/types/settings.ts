import type { Stage } from './deal';
import type { User } from './user';

export type Settings = {
    id: number;
    default_stage: Stage;
    default_agent: User;
}