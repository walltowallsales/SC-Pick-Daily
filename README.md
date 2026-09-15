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

## Inventory correction during picking
If the quantity on hand at the current location is wrong, tap **Quantity is incorrect**, enter the actual count, and tap **Update SellerChamp**. The app updates that SellerChamp inventory location when a location ID is available, otherwise it safely falls back to the matching variant or product. The correction is logged in the saved pick batch and the corrected quantity is marked verified.

- Adds secondary buttons below Back/Next to open the eBay listing when SellerChamp provides a marketplace URL/ID and to open the SellerChamp product page. Extra spacing separates them from the picking navigation.

- v10: Renames inventory correction to Adjust Quantity with stronger button styling; quantity-on-hand verification is shown/required only when on-hand is 1–3; condition display prefers the eBay condition and appends the item remarks description as `Condition - Remarks` when remarks are present.

- v11: Enlarges the pick location and product image, tightens spacing between Quantity to Pick and its value, displays the pick quantity in red, and adds clearer vertical separation between the image and title.

- v12: Restores the prior image size, adds a border around the image and a thick divider before the title, renames the on-hand label to QTY LEFT, and slightly increases related picker font sizing.

- v13 fix: Changes the actual picker HTML label from `Qty on hand at this location after pick` to `QTY LEFT`.

- v14: QTY LEFT verification checkbox now says only VERIFIED; location is larger; Quantity to Pick value is moved next to its label and emphasized with red text, border, and light background.

- v15: Makes the location larger, strengthens the divider between photo and title, and changes Open SellerChamp Product to open the SellerChamp Products section searched by the current SKU instead of opening the product-info detail URL.
