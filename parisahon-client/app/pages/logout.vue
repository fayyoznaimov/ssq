<template>
    <div class="container">
        {{ everywhere ? 'Выходим на всех устройствах…' : 'Bye bye' }}
    </div>
</template>

<script lang="ts" setup>
import { ability } from '~/utils/casl';

// /logout: this browser only. /logout?everywhere=1: every device of the account as well, and the
// CRM bot is unlinked from its Telegram (POST /auth/logout, see src/auth/sign-out.ts in the API).
const route = useRoute();
const router = useRouter();
const user = useState('user');
const access = useState('access');
const everywhere = route.query.everywhere === '1';

function forget() {
    localStorage.removeItem('token');
    user.value = undefined;
    access.value = null;
    ability.update([]);
    router.push({path: '/login'});
}

if (!process.server) {
    if (everywhere && useLoggedIn()) {
        // a refused token ends the session inside useService() as well
        useService('auth', {auth: true}).post('logout', {}).exec().catch(() => undefined).finally(forget);
    } else {
        forget();
    }
}
</script>

<style scoped>

</style>
