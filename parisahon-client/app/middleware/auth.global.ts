import type { User } from '~/types/user';
import { type AccessModel, ability, abilityFor } from '~/utils/casl';

/**
 * GET /auth/access: the user's rights by the API's own rules (src/auth/access.ts).
 * null when the API does not answer it (an older API): the rules are then built from the user card.
 * A 401 is passed on: useService() has already ended the session.
 */
function loadAccess(): Promise<AccessModel | null> {
    return useService('auth', { auth: true })
        .get<AccessModel>('access')
        .exec()
        .catch((e: any) => {
            if ((e?.statusCode ?? e?.status) === 401) throw e;
            return null;
        });
}

export default defineNuxtRouteMiddleware(async (to) => {
    if (!to.meta.authRoute)
        return;

    // useLoggedIn() is false (and the token is dropped) when the token has expired
    if (!useLoggedIn()) {
        return navigateTo('/login');
    }

    const user = useState<User>('user');
    const access = useState<AccessModel | null>('access', () => null);

    // Loaded once per page load, then refreshed in the background on every
    // navigation so that a role / permission change shows up without a re-login.
    // A 401 here (token rejected by the API) is handled inside useService():
    // the token is cleared and the browser goes to /login.
    const refresh = Promise.all([useUser().exec(), loadAccess()]).then(([u, rights]) => {
        user.value = u;
        access.value = rights;
        ability.update(abilityFor(u, rights));
        return u;
    });

    if (!user.value) {
        try {
            await refresh;
        } catch (e: any) {
            if ((e?.statusCode ?? e?.status) === 401) return navigateTo('/login');
            throw e;
        }
    } else {
        refresh.catch(() => undefined);
    }

    // The call recorder settings are for the admin only (the API answers 403 to everybody else)
    if (to.path === '/settings/calls' || to.path.startsWith('/settings/calls/')) {
        if (!ability.can('read', 'CallRecorder')) return navigateTo('/403');
    }

    if (to.meta.subject && !ability.can('read', to.meta.subject)) {
        return navigateTo('/');
    }

    // The analytics pages do not declare a `subject`, so they used to open by a
    // direct link for everybody (the API answered 403 and the page showed an
    // empty table). The API allows them to admin and manager only; everybody
    // else lands on the "Доступ запрещён" page.
    if (to.path === '/analytics' || to.path.startsWith('/analytics/')) {
        if (!ability.can('read', 'Analytics')) return navigateTo('/403');
    }
});
