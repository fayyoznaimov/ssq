<template>
    <div class="container">
        Bye bye
    </div>
</template>

<script lang="ts" setup>
const router = useRouter();
const user = useState('user');
if (!process.server) {
    localStorage.removeItem('token');
    router.push({path: '/login'});
    user.value = undefined;
}
</script>

<style scoped>

</style>