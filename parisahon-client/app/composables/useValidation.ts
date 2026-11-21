import { type Schema, validateKey, validateSchema } from '~/utils/validation';

export function useValidation<K extends string>(schema: Schema<K>) {
    const errors = ref<Record<K, string>>({} as Record<K, string>);
    const touched = ref<string[]>([]);

    function onChange(key: K, value: any) {
        if (!touched.value.includes(key)) return;
        const result = validateKey(key, value, schema);
        if (!result.ok) errors.value[key] = result.error;
        else delete errors.value[key];
    }

    function validate(data: Record<K, any>) {
        const result = validateSchema(schema, data);
        touched.value = Object.keys(result.errors);
        errors.value = result.errors;
        return result;
    }

    function reset() {
        touched.value = [];
        errors.value = {};
    }

    return { onChange, validate, errors, reset };
}
