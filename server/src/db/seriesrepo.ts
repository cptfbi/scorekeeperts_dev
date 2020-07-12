import { SeriesEvent, SeriesSettings, DefaultSettings, UUID } from '@common/lib'
import { IDatabase, IMain, ColumnSet } from 'pg-promise'
import { ScorekeeperProtocol } from '.'

let eventcols: ColumnSet|undefined

export class SeriesRepository {
    constructor(private db: IDatabase<any>, private pgp: IMain) {
        if (eventcols === undefined) {
            eventcols = new pgp.helpers.ColumnSet([
                { name: 'eventid', cnd: true, cast: 'uuid' },
                { name: 'date', cast: 'date' },
                { name: 'regopened', cast: 'timestamp' },
                { name: 'regclosed', cast: 'timestamp' },
                'name', 'champrequire', 'useastiebreak', 'isexternal', 'ispro', 'ispractice',
                'regtype', 'courses', 'runs', 'countedruns', 'segments', 'perlimit', 'totlimit', 'sinlimit',
                'conepen', 'gatepen', 'accountid',
                { name: 'attr', cast: 'json' },
                { name: 'modified', cast: 'timestamp', mod: ':raw', init: (): any => { return 'now()' } },
                { name: 'created',  cast: 'timestamp', init: (col: any): any => { return col.exists ? col.value : 'now()' } }
            ], { table: 'events' })
        }
    }

    async setSeries(series: string): Promise<null> {
        return this.db.none(`set search_path= '${series}', 'public'`)
    }

    async checkSeriesLogin(series: string, password: string): Promise<void> {
        if ((await this.db.one('SELECT data FROM localcache WHERE name=$1', [series])).data !== password) {
            throw Error('Invalid password')
        }
    }

    async seriesList(): Promise<string[]> {
        const results = await this.db.any('SELECT schema_name FROM information_schema.schemata ' +
            "WHERE schema_name NOT LIKE 'pg_%' AND schema_name NOT IN ('information_schema', 'public', 'template')")
        return results.map(v => v.schema_name)
    }

    async emailListIds(): Promise<string[]> {
        const ids = new Set<string>()
        for (const series of await this.seriesList()) {
            const results = await this.db.any('SELECT val FROM $1:name.settings WHERE name=\'emaillistid\'', series)
            results.forEach(r => ids.add(r.val))
        }
        return Array.from(ids.values()).sort()
    }

    _db2obj(key: string, val: string, obj: SeriesSettings): void {
        // Convert from text columns to local data type
        if (!(key in obj)) {
            obj[key] = val
        } else if (typeof (obj[key])  === 'boolean') {
            obj[key] = (val === '1')
        } else if (typeof (obj[key]) === 'number') {
            obj[key] = parseInt(val)
        } else {
            obj[key] = val
        }
    }

    _obj2db(def: DefaultSettings, key: string, val: any): string {
        // Convert from local data type back into text columns
        if (!(key in def)) { return val.toString() } else if (typeof (def[key]) === 'boolean') { return val ? '1' : '0' }
        return val.toString()
    }

    async superUniqueNumbers(): Promise<boolean> {
        return (await this.db.one("SELECT val FROM settings WHERE name='superuniquenumbers'")) === '1'
    }

    async seriesSettings(): Promise<SeriesSettings> {
        const ret: SeriesSettings = new DefaultSettings();
        (await this.db.any('SELECT name,val FROM settings')).forEach(r => {
            this._db2obj(r.name, r.val, ret)
        })
        return ret
    }

    async updateSettings(settings: SeriesSettings): Promise<SeriesSettings> {
        const def: SeriesSettings = new DefaultSettings()
        await this.db.tx(async tx => {
            for (const key in settings) {
                const val = this._obj2db(def, key, settings[key])
                await this.db.none('UPDATE settings SET val=$1,modified=now() WHERE name=$2', [val, key])
            }
        })
        return this.seriesSettings()
    }

    async eventList(): Promise<SeriesEvent[]> {
        return this.db.task(async task => {
            const ret: SeriesEvent[] = await task.any('SELECT * FROM events')
            await this.loadItemMap(task, ret)
            return ret
        })
    }

    async getEvent(eventid: UUID): Promise<SeriesEvent> {
        return this.db.task(async task => {
            const ret: SeriesEvent = await task.one('SELECT * FROM events WHERE eventid=$1', [eventid])
            await this.loadItemMap(task, [ret])
            return ret
        })
    }

    private async loadItemMap(tx: ScorekeeperProtocol, events: SeriesEvent[]) {
        for (const event of events) {
            event.items = (await tx.any('SELECT itemid FROM itemeventmap WHERE eventid=$1', [event.eventid])).map(r => r.itemid)
        }
    }

    private async updateItemMap(tx: ScorekeeperProtocol, events: SeriesEvent[]) {
        for (const event of events) {
            await tx.none('DELETE FROM itemeventmap WHERE eventid=$1 AND itemid NOT IN ($1:csv)', [event.eventid, event.items])
            for (const itemid of event.items) {
                await tx.any('INSERT INTO itemeventmap (eventid, itemid) VALUES ($1, $2) ON CONFLICT (eventid, itemid) DO NOTHING', [event.eventid, itemid])
            }
        }
    }

    async updateEvents(type: string, events: SeriesEvent[]): Promise<SeriesEvent[]> {
        return await this.db.tx(async tx => {
            if (type === 'insert') {
                const ret: SeriesEvent[] = await tx.any(this.pgp.helpers.insert(events, eventcols) + ' RETURNING *')
                await this.updateItemMap(tx, events)
                await this.loadItemMap(tx, ret)
                return ret
            }
            if (type === 'update') {
                await this.db.none(this.pgp.helpers.update(events, eventcols) + ' WHERE v.eventid=t.eventid')
                await this.updateItemMap(tx, events)
                // UPDATE won't return event if nothing changed, still need return for item only updates
                const ret: SeriesEvent[] = await tx.any('SELECT * FROM events WHERE eventid in ($1:csv)', events.map(e => e.eventid))
                await this.loadItemMap(tx, ret)
                return ret
            }
            if (type === 'delete') return this.db.any('DELETE from events WHERE eventid in ($1:csv) RETURNING carid', events.map(e => e.eventid))
            throw Error(`Unknown operation type ${JSON.stringify(type)}`)
        })
    }
}
