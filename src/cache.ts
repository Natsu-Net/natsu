interface CacheItem {
    data: Uint8Array | string | ArrayBuffer|Record<string|number,unknown>;
    expire: number;
}

class Cache {
    private cache: Map<string, CacheItem> = new Map();
    private ttl: number;
    private autoclear: boolean;

    constructor (ttl: number = 900, autoclear: boolean = true) {
        this.ttl = ttl;
        this.autoclear = autoclear;

		// set interval to clear expired cache
		if (this.autoclear)  {
			setInterval(() => {
				this.RemoveExpired();
			}, 1000);
		}
    }

    public get(key: string): Uint8Array | string | ArrayBuffer | Record<string|number,unknown> | false {
        const item = this.cache.get(key);
        if (item) {
            if (item.expire > (Date.now() / 1000)) {
                return item.data;
            } else {
                this.cache.delete(key);
                return false;
            }
        }
        return false;
    }

    public set(key: string, data: Uint8Array | string | ArrayBuffer | Record<string|number,unknown>, expire: number = this.ttl) {
        this.cache.set(key, {
            data,
            expire: (Date.now() / 1000) + expire
        });
    }

    public has(key: string): boolean {
        return this.cache.has(key);
    }

    public Remove(key: string) {
        this.cache.delete(key);
    }

    public clear() {
        this.cache.clear();
    }

    public getSize(): number {
        return this.cache.size;
    }

    public getOrSet(key: string, getData: () => Uint8Array | string | ArrayBuffer | Record<string|number,unknown>, expire: number = this.ttl): Uint8Array | string | ArrayBuffer | Record<string|number,unknown> {
        const data = this.get(key);
        if (data !== false) {
            return data;
        }
        const newData = getData();
        this.set(key, newData, expire);
        return newData;
    }

    public RemoveExpired() {
        for (const [key, value] of this.cache) {
            if (value.expire <= Date.now() / 1000) {
                this.cache.delete(key);
            }
        }
    }
}

const defaultCache = new Cache();

export { Cache, defaultCache };
