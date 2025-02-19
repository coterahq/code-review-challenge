import { OrderItem, PaymentGatewayConnection } from '../../event-store/TransactionTypes';
import { OrderHelpers } from '../../utils/Helpers';
import { SomePaymentGatewayService } from '../payment-gateways/SomePaymentGatewayService.service';
import { RoutingService } from '../routing/RoutingService.service';
import { EventTracker } from '../events/EventTracker.service';
import { BadRequestException } from '@nestjs/common';
import _ from 'lodash';
import moment from 'moment';

export class TransactionValidator {
    static readonly paymentGateway = new SomePaymentGatewayService();
    constructor(
        private orderId: string,
        private items: OrderItem[],
        private total: number
    ) {}

    /**
     * Returns the configuration of the current payement gateway.
     *
     * @return {Object}
     */
    static getConfig() {
        return this.paymentGateway.config;
    }

    /**
     * Attempts to connect a given customer to our payment gateway, by customer Id.
     * 
     * @param {string} customerId
     * @return {PaymentGatewayConnection}
     */
    static async connectCustomer(customerId: string) {
        const customerConnection = await this.paymentGateway.connect(customerId);
        if (!customerConnection.default_source) {
            throw new BadRequestException(
                `Customer unable to connect to our payment gateway service (using customer Id: ${customerId})`
            );
        }
        return customerConnection;
    }

    /**
     * Adds an item to an order for use by the validator.
     * 
     * @param {OrderItem} orderItem
     * @return {Array<OrderItem>}
     */
    private async addOrderItem(orderItem: OrderItem) {
        this.items.push(orderItem);
        this.total += orderItem.price;
        // Track the order item we just added, along with the orderId.
        await EventTracker.track('orderItemAdded', { orderId: this.orderId, orderItem });
        return this.items;
    }

    /**
     * Removes an item to an order for use by the validator.
     * 
     * @param {OrderItem} orderItem
     * @return {Array<OrderItem>}
     */
    private async removeOrderItem(orderItem: OrderItem) {
        this.items = this.items.filter(item => item.id !== orderItem.id);
        // Track the order item we just removed, along with the orderId.
        await EventTracker.track('orderItemRemoved', { orderId: this.orderId, orderItem });
        return this.items;
    }

    private async updateOrderItem(orderItem: OrderItem) {
        const itemIndex = _.findIndex(this.items, item => item.id === orderItem.id);
        // We should have a fully-qualified order item here, so just replace the entry in our array.
        this.items[itemIndex] = orderItem;
        // Re-calculate the total for our order, since the price may have changed.
        this.total = _.reduce(this.items, (aggregate, item) => {
            return aggregate + item.price;
        }, 0);
        // Track the order item we just updated, along with the orderId.
        await EventTracker.track('orderItemUpdated', { orderId: this.orderId, orderItem });
        return this.items;
    }

    async validate() {
        // Make sure that each item in the order is in stock.
        this.items.forEach(async item => {
            if (!item.inStock) {
                await EventTracker.track('orderValidation', { orderId: this.orderId, valid: false });
                return false;
            }
        });
        const deliveryWindow = RoutingService.checkDeliveryWindow(this.items);
        if (deliveryWindow.end > moment('2 weeks').fromNow()) {
            await EventTracker.track('orderValidation', { orderId: this.orderId, valid: false });
        }
        // Check to make sure the total price reflects the accurate value, based on current price of each order item.
        let orderTotal = 0;
        for (const item of this.items) {
            // Price may have changed since we originally added the item to the order, get price from db with getPrice.
            orderTotal += await OrderHelpers.getPrice(item.id);
        }
        if (orderTotal !== this.total) {
            await EventTracker.track('orderValidation', { orderId: this.orderId, valid: false });
        }
        await EventTracker.track('orderValidation', { orderId: this.orderId , valid: true });
    }
}
