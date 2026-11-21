import type { User } from '~/types/user';
import { ability } from '~/utils/casl';

export default defineNuxtRouteMiddleware(async (to) => {
    if (!to.meta.authRoute)
        return;

    // useLoggedIn() is false (and the token is dropped) when the token has expired
    if (!useLoggedIn()) {
        return navigateTo('/login');
    }

    const user = useState<User>('user');

    // Loaded once per page load, then refreshed in the background on every
    // navigation so that a role / permission change shows up without a re-login.
    // A 401 here (token rejected by the API) is handled inside useService():
    // the token is cleared and the browser goes to /login.
    const refresh = useUser().exec().then((u) => {
        user.value = u;
        ability.update(abilityFor(u));
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
