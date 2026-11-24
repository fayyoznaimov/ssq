import { Ability, AbilityBuilder,type AbilityClass, defineAbility } from '@casl/ability';

import { type User, UserRole } from '~/types/user';

export const ability = defineAbility(() => { });

type Actions = 'create' | 'read' | 'update' | 'delete' | 'manage';
type Subjects = 'Deal' | 'Contact' | 'Company' | 'Task' | 'File' | 'Mail' | 'all';

export type AppAbility = Ability<[Actions, Subjects]>;
export const AppAbility = Ability as AbilityClass<AppAbility>;

// Menu subjects of the "Аналитика" section (see app.config.ts)
export const ANALYTICS_SUBJECTS = [
    'Analytics',
    'Sales-Analytics',
    'Manager-Analytics',
    'Employee-Analytics',
    'Product-Analytics',
    'Event',
    'Goals',
    'Consolidated',
    'Calls',
    'Control',
];

/** How far a right reaches, as the API counts it (src/auth/access.ts). */
export type AccessScope = 'none' | 'own' | 'group' | 'all';
type ScopeAction = 'view' | 'create' | 'update' | 'delete';

/**
 * GET /auth/access: what the signed-in user may see and change, by the API's own rules
 * (src/auth/access.ts, the same class the API, the CRM bot and the deal trash use).
 */
export type AccessModel = {
    user_id: number;
    role: UserRole;
    group_id: number | null;
    /** staff of the user's group, the user included (the level "Для группы"); null: not known */
    group_user_ids: number[] | null;
    admin: boolean;
    /** admin or manager: every record, analytics, the action log */
    manager: boolean;
    scopes: {
        deal: Record<ScopeAction, AccessScope>;
        company: Record<ScopeAction, AccessScope>;
        contact: Record<ScopeAction, AccessScope>;
        task: Record<ScopeAction, AccessScope>;
    };
    mail: boolean;
    file: boolean;
};

const LEVEL_TO_SCOPE: AccessScope[] = ['none', 'own', 'group', 'all'];

/**
 * The same rules from the user card alone, for an API that does not answer GET /auth/access yet
 * (keep in step with Access.scope() in src/auth/access.ts). The levels: 0 nothing, 1 where the user is
 * responsible, 2 the user's group, 3 everything. Admin and manager: everything. A level that is not
 * stored: the agent's own deals, every company, contact and task. Creating: any level above 0.
 * The switches "mail" / "file": on unless switched off.
 */
export function accessFromUser(user: User): AccessModel {
    const everything = user.role === UserRole.Admin || user.role === UserRole.Manager;
    const permissions: any = user.permissions ?? {};
    const scope = (entity: string, action: ScopeAction): AccessScope => {
        if (everything) return 'all';
        const level = permissions?.[entity]?.[action];
        if (typeof level !== 'number') return entity === 'deal' && action !== 'create' ? 'own' : 'all';
        if (action === 'create') return level > 0 ? 'all' : 'none';
        return LEVEL_TO_SCOPE[level] ?? 'none';
    };
    const actions = (entity: string): Record<ScopeAction, AccessScope> => ({
        view: scope(entity, 'view'),
        create: scope(entity, 'create'),
        update: scope(entity, 'update'),
        delete: scope(entity, 'delete'),
    });
    return {
        user_id: user.id,
        role: user.role,
        group_id: user.group?.id ?? null,
        group_user_ids: null,
        admin: user.role === UserRole.Admin,
        manager: everything,
        scopes: {
            deal: actions('deal'),
            company: actions('company'),
            contact: actions('contact'),
            task: { view: 'all', create: 'all', update: scope('task', 'update'), delete: scope('task', 'delete') },
        },
        mail: everything || permissions?.mail !== false,
        file: everything || permissions?.file !== false,
    };
}

/**
 * «Стандартные права» of an agent: their own deals, companies and contacts — see, create, change; their own
 * tasks — change; nothing to delete. The same template as STANDARD_LEVELS in src/auth/access.ts of the API
 * (POST /auth/standard-rights/:id gives it to an existing employee).
 */
export const STANDARD_PERMISSIONS = {
    deal: {view: 1, create: 3, update: 1, delete: 0, export: 0},
    company: {view: 1, create: 3, update: 1, delete: 0, export: 0},
    contact: {view: 1, create: 3, update: 1, delete: 0, export: 0},
    task: {update: 1, delete: 0},
};

/**
 * What the card of an agent leaves them unable to see, by the API's rules: 'nothing' — no deals, companies or
 * contacts at all; 'deals' — not even the deals they are responsible for. null: nothing to warn about (admin
 * and manager see everything). The list «Пользователи» and the user card warn with it.
 */
export function blindSpot(user: Pick<User, 'role' | 'permissions'> & Partial<User>): 'nothing' | 'deals' | null {
    if (user.role !== UserRole.Agent) return null;
    const {scopes} = accessFromUser(user as User);
    if (scopes.deal.view !== 'none') return null;
    return scopes.company.view === 'none' && scopes.contact.view === 'none' ? 'nothing' : 'deals';
}

/**
 * CASL conditions of a deal scope on the deal object (deal.agent is the responsible user), as the API
 * decides (Access.allowsDeal): null means every deal, false none.
 */
function dealConditions(scope: AccessScope, access: AccessModel): Record<string, any> | null | false {
    switch (scope) {
        case 'all':
            return null;
        case 'own':
            return { 'agent.id': access.user_id };
        case 'group':
            // the group is not known (older API): the API checks every deal itself
            if (!access.group_user_ids) return null;
            return { 'agent.id': { $in: access.group_user_ids } };
        default:
            return false;
    }
}

/**
 * The menu, the pages and the buttons of the web client follow the API's rules: `access` comes from
 * GET /auth/access (accessFromUser() when the API does not answer it). A right at the level "own" or
 * "group" opens the section (the API lists only the records in reach), and the buttons of a deal are
 * checked against its responsible user. Which companies and contacts are in reach the API decides per
 * record (created by the user or the group, or linked to their deals).
 */
export function abilityFor(user: User, access?: AccessModel | null) {
    const { can, rules } = new AbilityBuilder(Ability);

    if (user.role === UserRole.Admin) {
        can('manage', 'all');
        return rules;
    }

    const model = access ?? accessFromUser(user);

    can('manage', 'Telegram');
    can('manage', 'WhatsApp');
    can('manage', 'Profile');
    // «Записи звонков»: every staff member has their own recordings (/lists/calls opens them, GET /calls/staff/:id)
    can('read', 'Call');

    // Tasks: every staff user sees and creates them; changing and deleting are checked per task by the API
    can('read', 'Task');
    can('create', 'Task');
    if (model.scopes.task.update !== 'none') can('update', 'Task');
    if (model.scopes.task.delete !== 'none') can('delete', 'Task');

    // Same rule as the API: analytics, goals and the event log are for admin and
    // manager (@Roles(MANAGER_LEVEL) on the analytics / objective / tracking
    // controllers). Changing goals stays admin-only on the server.
    if (model.manager) {
        ANALYTICS_SUBJECTS.forEach((subject) => can('read', subject));
    }

    // Deals: seeing, changing and moving to the trash (the trash and restoring follow "delete",
    // src/deal/deal-access.ts); deleting for good stays admin-only.
    const dealVerbs: [ScopeAction, Actions][] = [['view', 'read'], ['update', 'update'], ['delete', 'delete']];
    for (const [action, verb] of dealVerbs) {
        const conditions = dealConditions(model.scopes.deal[action], model);
        if (conditions === false) continue;
        if (conditions === null) can(verb, 'Deal');
        else can(verb, 'Deal', conditions);
    }
    if (model.scopes.deal.create !== 'none') can('create', 'Deal');

    const records: ['Company' | 'Contact', 'company' | 'contact'][] = [['Company', 'company'], ['Contact', 'contact']];
    for (const [subject, entity] of records) {
        const scopes = model.scopes[entity];
        if (scopes.view !== 'none') {
            can('read', 'List');
            can('read', subject);
        }
        if (scopes.create !== 'none') can('create', subject);
        if (scopes.update !== 'none') can('update', subject);
        if (scopes.delete !== 'none') can('delete', subject);
    }

    // The product catalogue: everyone reads it (GET /products); changing it is for managers
    // (the API deletes products for admin and manager only)
    can('read', 'List');
    can('read', 'Product');
    if (model.manager) {
        can('create', 'Product');
        can('update', 'Product');
        can('delete', 'Product');
    }

    if (model.mail) {
        can('read', 'Mail');
    }

    if (model.file) {
        can('read', 'File');
    }

    return rules;
}
