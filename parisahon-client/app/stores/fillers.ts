import type { FillersResponse } from "~/types/filler";

export const useFillersStore = defineStore("fillers", () => {
    const { data: fillers, run: fetchFillers } = useAsync<FillersResponse>();

    return {
        fillers,
        fetchFillers
    };
});