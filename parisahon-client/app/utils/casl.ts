import { Ability, AbilityBuilder,type AbilityClass, defineAbility } from '@casl/ability';

import { PermissionLevel,type User, UserRole } from '~/types/user';

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

export function abilityFor(user: User) {
    const { can, rules } = new AbilityBuilder(Ability);

    if (user.role === UserRole.Admin) {
        can('manage', 'all');
        return rules;
    }

    can('manage', 'Telegram');
    can('manage', 'WhatsApp');
    can('manage', 'Profile');
    can('manage', 'Task');

    // Same rule as the API: analytics, goals and the event log are for admin and
    // manager (@Roles(MANAGER_LEVEL) on the analytics / objective / tracking
    // controllers). Changing goals stays admin-only on the server.
    if (user.role === UserRole.Manager) {
        ANALYTICS_SUBJECTS.forEach((subject) => can('read', subject));
    }

    // Moving deals to the trash, seeing the trash and restoring: the API's rule
    // (src/deal/deal-access.ts): the "delete" level of deal permissions — 1 deals where the
    // user is responsible, 2 deals of the group (the API filters), 3 every deal. Without stored
    // permissions: a manager every deal, an agent their own deals. Deleting for good: admin only.
    const dealDelete = user.permissions?.deal?.delete
        ?? (user.role === UserRole.Manager ? PermissionLevel.Allowed : PermissionLevel.Responsible);
    if (dealDelete === PermissionLevel.Responsible) {
        can('delete', 'Deal', { 'agent.id': user.id });
    } else if (dealDelete === PermissionLevel.Member || dealDelete === PermissionLevel.Allowed) {
        can('delete', 'Deal');
    }

    if (!user.permissions) return rules;

    if (user.permissions.deal.create === PermissionLevel.Allowed) {
        can('create', 'Deal');
    }

    if (user.permissions.deal.update === PermissionLevel.Allowed) {
        can('update', 'Deal');
    }

    if (user.permissions.deal.update === PermissionLevel.Responsible) {
        can('update', 'Deal', { 'agent.id': user.id });
    }

    if (user.permissions.deal.view === PermissionLevel.Allowed) {
        can('read', 'Deal');
    }

    if (user.permissions.contact.view === PermissionLevel.Allowed) {
        can('read', 'List');
        can('read', 'Contact');
    }

    if (user.permissions.contact.create === PermissionLevel.Allowed) {
        can('create', 'Contact');
    }

    if (user.permissions.contact.update === PermissionLevel.Allowed) {
        can('update', 'Contact');
    }

    if (user.permissions.contact.delete === PermissionLevel.Allowed) {
        can('delete', 'Contact');
    }

    if (user.permissions.company.view === PermissionLevel.Allowed) {
        can('read', 'List');
        can('read', 'Company');
    }

    if (user.permissions.company.create === PermissionLevel.Allowed) {
        can('create', 'Company');
    }

    if (user.permissions.company.update === PermissionLevel.Allowed) {
        can('update', 'Company');
    }

    if (user.permissions.company.delete === PermissionLevel.Allowed) {
        can('delete', 'Company');
    }

    if (user.permissions.mail) {
        can('read', 'Mail');
    }

    if (user.permissions.file) {
        can('read', 'File');
    }

    return rules;
}
