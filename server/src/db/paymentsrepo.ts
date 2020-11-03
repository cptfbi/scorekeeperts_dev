import { IDatabase, ColumnSet, IMain } from 'pg-promise'
import _ from 'lodash'

import { verifyDriverRelationship, cleanAttr } from './helper'
import { PaymentAccount, PaymentItem, PaymentAccountSecret } from '@common/payments'
import { UUID, validateObj } from '@common/util'
import { Payment, PaymentValidator } from '@common/register'
import { ItemMap } from '@/common/event'

let paymentcols: ColumnSet|undefined
let secretcols: ColumnSet|undefined
let accountcols: ColumnSet|undefined
let itemcols: ColumnSet|undefined
let itemmapcols: ColumnSet|undefined

export class PaymentsRepository {
    // eslint-disable-next-line no-useless-constructor
    constructor(private db: IDatabase<any>, private pgp: IMain) {
        if (paymentcols === undefined) {
            paymentcols = new pgp.helpers.ColumnSet([
                { name: 'payid',    cnd: true, cast: 'uuid' },
                { name: 'eventid',  cast: 'uuid' },
                { name: 'driverid', cast: 'uuid' },
                { name: 'carid',    cast: 'uuid', def: null },
                { name: 'session',  def: null },
                { name: 'txtype' },
                { name: 'txid' },
                { name: 'txtime',   cast: 'timestamp' },
                { name: 'amount' },
                { name: 'refunded' },
                { name: 'itemname' },
                { name: 'accountid' },
                { name: 'modified', cast: 'timestamp', mod: ':raw', init: (): any => { return 'now()' } }
            ], { table: 'payments' })
        }

        if (accountcols === undefined) {
            accountcols = new pgp.helpers.ColumnSet([
                { name: 'accountid', cnd: true },
                { name: 'name' },
                { name: 'type' },
                { name: 'attr',     cast: 'json', init: (col: any): any => { return cleanAttr(col.value) } },
                { name: 'modified', cast: 'timestamp', mod: ':raw', init: (): any => { return 'now()' } }
            ], { table: 'paymentaccounts' })
        }

        if (secretcols === undefined) {
            secretcols = new pgp.helpers.ColumnSet([
                { name: 'accountid', cnd: true },
                { name: 'secret' },
                { name: 'attr',     cast: 'json', init: (col: any): any => { return cleanAttr(col.value) } },
                { name: 'modified', cast: 'timestamp', mod: ':raw', init: (): any => { return 'now()' } }
            ], { table: 'paymentsecrets' })
        }

        if (itemcols === undefined) {
            itemcols = new pgp.helpers.ColumnSet([
                { name: 'itemid', cnd: true },
                { name: 'name' },
                { name: 'itemtype' },
                { name: 'price' },
                { name: 'currency' },
                { name: 'modified', cast: 'timestamp', mod: ':raw', init: (): any => { return 'now()' } }
            ], { table: 'paymentitems' })
        }

        if (itemmapcols === undefined) {
            itemmapcols = new pgp.helpers.ColumnSet([
                { name: 'eventid', cnd: true, cast: 'uuid' },
                { name: 'itemid',  cnd: true },
                { name: 'maxcount', cast: 'int' },
                { name: 'required', cast: 'bool' },
                { name: 'modified', cast: 'timestamp', mod: ':raw', init: (): any => { return 'now()' } }
            ], { table: 'itemeventmap' })
        }
    }

    async getPaymentAccounts(): Promise<PaymentAccount[]> {
        return this.db.any('SELECT * FROM paymentaccounts')
    }

    async getPaymentItems(): Promise<PaymentItem[]> {
        return this.db.query('SELECT * from paymentitems')
    }

    async updatePaymentItems(type: string, items: PaymentItem[]): Promise<PaymentItem[]> {
        if (type === 'insert') { return this.db.any(this.pgp.helpers.insert(items, itemcols) + ' RETURNING *') }
        if (type === 'update') { return this.db.any(this.pgp.helpers.update(items, itemcols) + ' WHERE v.itemid = t.itemid RETURNING *') }
        if (type === 'delete') {
            const rows = await this.db.any('SELECT DISTINCT e.name,e.date FROM itemeventmap m JOIN events e ON m.eventid=e.eventid ' +
                                           'WHERE m.itemid IN ($1:csv) ORDER BY e.date', [items.map(i => i.itemid)])
            if (rows.length > 0) {
                throw Error(`Items(s) still in use for events (${rows.map(r => r.name).join(', ')})`)
            }
            return this.db.any('DELETE from paymentitems WHERE itemid in ($1:csv) RETURNING itemid', items.map(i => i.itemid))
        }
        throw Error(`Unknown operation type ${JSON.stringify(type)}`)
    }

    async getItemMaps(): Promise<ItemMap[]> {
        return this.db.any('SELECT * FROM itemeventmap')
    }

    async updateItemMaps(type: string, eventid: UUID, maps: ItemMap[]): Promise<ItemMap[]> {
        if (type === 'insert') {
            return this.db.any(this.pgp.helpers.insert(maps, itemmapcols) + ' RETURNING *')

        } else if (type === 'eventupdate') {
            await this.db.none(`DELETE FROM itemeventmap WHERE eventid=$1 ${maps.length > 0 ? 'AND itemid NOT IN ($2:csv)' : ''}`, [eventid, maps.map(m => m.itemid)])
            for (const itemmap of maps) {
                await this.db.any(this.pgp.helpers.insert([itemmap], itemmapcols) +
                                ' ON CONFLICT (eventid, itemid) DO UPDATE SET ' +
                                this.pgp.helpers.sets(itemmap, itemmapcols))
            }
            return this.db.any('SELECT * FROM itemeventmap WHERE eventid=$1', [eventid])
        }

        throw Error(`Unknown operation type for updateItemMaps ${JSON.stringify(type)}`)
    }

    async getPaymentAccount(accountid: string): Promise<PaymentAccount> {
        return this.db.one('SELECT * FROM paymentaccounts WHERE accountid=$1', [accountid])
    }

    async updatePaymentAccounts(type: string, accounts: PaymentAccount[]): Promise<PaymentAccount[]> {
        if (type === 'insert') { return this.db.any(this.pgp.helpers.insert(accounts, accountcols) + ' RETURNING *') }
        if (type === 'update') { return this.db.any(this.pgp.helpers.update(accounts, accountcols) + ' WHERE v.accountid = t.accountid RETURNING *') }
        if (type === 'delete') {
            const ids = accounts.map(a => a.accountid)
            const rows = await this.db.any('SELECT name FROM events WHERE accountid in ($1:csv) ORDER BY date', [ids])
            if (rows.length > 0) {
                throw Error(`Account(s) still in use for events (${rows.map(r => r.name).join(', ')})`)
            }
            return this.db.tx(t => {
                t.any('DELETE from paymentsecrets WHERE accountid in ($1:csv)', [ids])
                return t.any('DELETE from paymentaccounts WHERE accountid in ($1:csv) RETURNING accountid', [ids])
            })
        }
        throw Error(`Unknown operation type ${JSON.stringify(type)}`)
    }

    async getPaymentAccountSecret(accountid: string): Promise<PaymentAccountSecret> {
        return this.db.one('SELECT * FROM paymentsecrets WHERE accountid=$1', [accountid])
    }

    async updatePaymentAccountSecrets(type: string, secrets: PaymentAccountSecret[]): Promise<void> {
        if (type === 'insert') { await this.db.any(this.pgp.helpers.insert(secrets, secretcols)); return }
        if (type === 'update') { await this.db.any(this.pgp.helpers.update(secrets, secretcols) + ' WHERE v.accountid = t.accountid RETURNING *'); return }
        if (type === 'delete') { await this.db.any('DELETE from paymentsecrets WHERE accountid in ($1:csv)', secrets.map(s => s.accountid)); return }
        throw Error(`Unknown operation type ${JSON.stringify(type)}`)
    }

    /* Upserts */
    async upsertPaymentAccount(account: PaymentAccount): Promise<null> {
        return this.db.none('INSERT INTO paymentaccounts (accountid, name, type, attr) VALUES ($(accountid), $(name), $(type), $(attr)) ' +
                            'ON CONFLICT (accountid) DO UPDATE SET name=$(name), type=$(type), attr=$(attr), modified=now()', account)
    }

    async upsertPaymentSecret(secret: PaymentAccountSecret): Promise<null> {
        return this.db.none('INSERT INTO paymentsecrets (accountid, secret, attr) VALUES ($(accountid), $(secret), $(attr)) ' +
                            'ON CONFLICT (accountid) DO UPDATE SET secret=$(secret), attr=$(attr), modified=now()', secret)
    }
    /***********/

    async getPaymentsbyAccountId(accountid: UUID): Promise<Payment[]> {
        return this.db.any('SELECT * FROM payments WHERE attr->>\'accountid\'=$1', [accountid])
    }

    async getPaymentsbyDriverId(driverid: UUID): Promise<Payment[]> {
        return this.db.any('SELECT * FROM payments WHERE driverid=$1', [driverid])
    }

    async getAllPayments(eventid?: UUID): Promise<Payment[]> {
        return this.db.any('SELECT * FROM payments ' + (eventid ? 'WHERE eventid=$1 ' : ''), [eventid])
    }

    async updatePayments(type: string, payments: Payment[], driverid?: UUID): Promise<Payment[]> {
        if (driverid) {
            await verifyDriverRelationship(this.db, payments.map(p => p.carid).filter(v => v), driverid)
        }
        if (type !== 'delete') {
            payments.forEach(p => validateObj(p, PaymentValidator))
        }

        if (type === 'insert') { return this.db.any(this.pgp.helpers.insert(payments, paymentcols) + ' RETURNING *') }
        if (type === 'update') { return this.db.any(this.pgp.helpers.update(payments, paymentcols) + ' WHERE v.payid = t.payid RETURNING *') }
        if (type === 'delete') { return this.db.any('DELETE from payments WHERE payid in ($1:csv)', payments.map(p => p.payid)) }

        throw Error(`Unknown operation type ${JSON.stringify(type)}`)
    }
}
