# SellerChamp Pick Batch

A web app that creates a frozen snapshot of current SellerChamp orders, generates a portrait printable pick list, and provides a one-stop-at-a-time dynamic picking guide.

## What it does

- Pulls SellerChamp orders with `order_status=unshipped` and only includes orders from the last 30 days.
- Keeps paid, seller-fulfilled, non-hold orders.
- Excludes any order already stored in an existing pick batch.
- **Create Pick Batch** freezes the exact qualifying orders at that moment.
- Enriches order items from `/api/products` with condition, current quantity on hand, warehouse locations, and item image.
- Consolidates identical SKUs while retaining an order-number / quantity breakdown.
- Splits pick stops across multiple inventory locations when SellerChamp reports more than one location.
- Sorts pick stops naturally by location.
- Printable portrait pick list: Location, Qty, Image, SKU, Title, Condition, On Hand, Order(s).
- Dynamic guide with Back / Next, progress tracking, and persistent completion state.
- When quantity to pick is greater than 1, the employee must check **I picked all N** at the bottom of the page, directly above Next. Otherwise the app displays **Did you pick the full quantity?**
- Deleting a batch requires the delete PIN. Default: `8880`.

## Important workflow

Create the pick batch at the time of the shipping run (ideally immediately before/while you print that run). Once created, later orders are not added to that batch.

## Render deployment

This package includes `render.yaml`.

1. Create a new GitHub repository and upload all files in this folder.
2. In Render, create a new Blueprint from that repository (or a Web Service using `npm install` / `npm start`).
3. Set `SELLERCHAMP_TOKEN` to your SellerChamp API token.
4. Optionally set `APP_PIN`.
5. `ORDER_LOOKBACK_DAYS` defaults to `30`.
6. `DELETE_BATCH_PIN` defaults to `8880`.
5. The included Blueprint mounts a 1 GB persistent disk at `/var/data` and sets `DATA_DIR=/var/data`. **Keep the persistent disk** so frozen pick batches survive Render restarts/deploys.

If you create a Web Service manually instead of the Blueprint:
- Runtime: Node
- Build Command: `npm install`
- Start Command: `npm start`
- Environment: `SELLERCHAMP_TOKEN`, `SELLERCHAMP_BASE_URL=https://app.sellerchamp.com`, `QUALIFYING_ORDER_STATUS=unshipped`, `ORDER_LOOKBACK_DAYS=30`, `DELETE_BATCH_PIN=8880`, `DATA_DIR=/var/data`
- Persistent disk mount: `/var/data`

## Local testing

```bash
npm install
SELLERCHAMP_TOKEN=YOUR_TOKEN npm start
```
Then open `http://localhost:3000`.

## Qualifying-order note

The default is SellerChamp `unshipped`. If your exact shipping-label workflow changes SellerChamp order status before you press **Create Pick Batch**, change `QUALIFYING_ORDER_STATUS` to the status that represents the orders you want captured, or adjust `fetchAllQualifyingOrders()` in `server.js`.
