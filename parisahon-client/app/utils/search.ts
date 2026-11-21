import type {User} from "~/types/user";

export function debounce<T extends (...args: any[]) => void>(this: any, func: T, timeout: number = 500) {
    let timer: any;
    return (...args: any) => {
        clearTimeout(timer);
        timer = setTimeout(() => {
            func.apply(this, args);
        }, timeout);
    };
}

export interface Option {
    id: string;
    label: string;
}

export function usersRoleFilter(users:User[], role: string, roleTwo?: string): Option[] {
    return users.filter((user: User) => user.role === role || user.role === roleTwo).map((user: User) => {
        return {label: user.username, id: user.id};
    });
}

export async function optionsList(service: any, labelField: string, query?: Record<string, any>): Promise<Option[]> {
    const options: Option[] = [];
    const baseQ = {$limit: 1000, $select: ["id", labelField]};
    if(query) {
        Object.assign(baseQ, query);
    }
    const response = await service.find(baseQ).exec();
    const responseCount = response.count || response.length;
    const responseSize = response.page_size || 1;
    const responseData = response.data || response;
    if (responseCount > responseSize) {
        for (let i = 0; i < responseCount / responseSize; i++) {
            const items = await service.find({$skip: i * responseSize, ...baseQ}).list().exec();
            responseData.concat(items);
        }
    }
    responseData.forEach((item: any) => {
        options.push({id: item.id, label: item[labelField]});
    });
    return options;
}
