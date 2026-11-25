const express = require('express');

const router = express.Router();
const { sql, poolPromise } = require("../config");
const { requireStaffManager } = require("../middleware/auth");

const emptyToNull = (val) =>
    (val === undefined || val === null || (typeof val === "string" && val.trim() === "")) ? null : val;

const sendError = (res, error, action = "Operation") => {
    console.error(`${action} Error:`, error);
    return res.status(500).json({ success: false, message: error.message || `${action} failed` });
};

router.post("/getCategories", async (req, res) => {
    try {
        // console.log(req.body) || {};
        
        const { INCLUDE_INACTIVE = 0 } = req.body;

        const pool = await poolPromise;

        const result = await pool.request()
            .input(
                "INCLUDE_INACTIVE",
                sql.Bit,
                INCLUDE_INACTIVE ? 1 : 0
            )
            .execute("dbo.PROC_CATEGORY_DETAILS");

        return res.status(200).json({
            success: true,
            message: "Category details fetched successfully",
            data: result.recordset
        });

    } catch (error) {
        console.error("Get Categories Error:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to fetch category details"
        });
    }
});

router.post("/getAllProducts", async (req, res) => {
    try {
        const {
            categoryId = null,
            search = null,
            featuredOnly = 0,
            pageNumber = 1,
            pageSize = 20,
            includeInactive = 0
        } = req.body;

        // Validate category ID
        let category = null;

        if (categoryId !== null && categoryId !== "") {
            category = Number(categoryId);

            if (!Number.isInteger(category) || category < 1) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid category ID"
                });
            }
        }

        // Validate pagination
        const page = Number(pageNumber);
        const size = Number(pageSize);

        if (!Number.isInteger(page) || page < 1 ||
            !Number.isInteger(size) || size < 1) {
            return res.status(400).json({
                success: false,
                message: "Invalid page number or page size"
            });
        }

        // Validate featuredOnly
        if (![0, 1, true, false].includes(featuredOnly)) {
            return res.status(400).json({
                success: false,
                message: "featuredOnly must be 0 or 1"
            });
        }

        // Validate search
        if (search !== null && typeof search !== "string") {
            return res.status(400).json({
                success: false,
                message: "Invalid search value"
            });
        }

        if (search && search.length > 200) {
            return res.status(400).json({
                success: false,
                message: "Search cannot exceed 200 characters"
            });
        }

        const featured = featuredOnly ? 1 : 0;
        const effectivePageSize = Math.min(size, 100);

        // Database connection
        const pool = await poolPromise;

        // Execute stored procedure
        const result = await pool.request()
            .input("CATEGORY_ID", sql.Int, category)
            .input("SEARCH", sql.NVarChar(200), search?.trim() || null)
            .input("FEATURED_ONLY", sql.Bit, featured)
            .input("PAGE_NUMBER", sql.Int, page)
            .input("PAGE_SIZE", sql.Int, effectivePageSize)
            .input("INCLUDE_INACTIVE", sql.Bit, includeInactive ? 1 : 0)
            .execute("PROC_EB_GET_ALL_PRODUCTS");

        // Extract recordsets
        const categories = result.recordsets[0] || [];
        const products = result.recordsets[1] || [];
        const countData = result.recordsets[2] || [];

        const totalRecords = countData.length > 0
            ? countData[0].TOTAL_RECORDS
            : 0;

        // Image URL configuration
        const baseURL = `${req.protocol}://${req.get("host")}`;

        const getImageURL = (image, folder) => {
            if (!image) return null;

            const fileName = String(image)
                .replace(/\\/g, "/")
                .split("/")
                .pop();

            if (!fileName) return null;

            return `${baseURL}/uploads/${folder}/${encodeURIComponent(fileName)}`;
        };

        // Category images
        const categoriesWithImages = categories.map(category => ({
            ...category,
            CATEGORY_IMAGE: getImageURL(
                category.CATEGORY_IMAGE,
                "categories"
            )
        }));

        // Product images
        const productsWithImages = products.map(product => ({
            ...product,
            PRODUCT_IMAGE: getImageURL(
                product.PRODUCT_IMAGE,
                "products"
            )
        }));

        return res.status(200).json({
            success: true,
            message: "Products fetched successfully",

            categories: categoriesWithImages,

            products: productsWithImages,

            pagination: {
                pageNumber: page,
                pageSize: effectivePageSize,
                totalRecords: totalRecords,
                totalPages: Math.ceil(totalRecords / effectivePageSize)
            }
        });

    } catch (error) {
        console.error("Get All Products API Error:", error);

        return res.status(500).json({
            success: false,
            message: "Internal Server Error"
        });
    }
});
router.post("/admin/getProducts", requireStaffManager, async (req, res) => {
    try {
        const b = req.body;
        const page = Math.max(1, Number(b.pageNumber) || 1);
        const size = Math.min(100, Math.max(1, Number(b.pageSize) || 20));

        const pool = await poolPromise;
        const result = await pool.request()
            .input("CATEGORY_ID",      sql.Int,           emptyToNull(b.categoryId))
            .input("SEARCH",           sql.NVarChar(200), emptyToNull(b.search))
            .input("FEATURED_ONLY",    sql.Bit,           b.featuredOnly ? 1 : 0)
            .input("PAGE_NUMBER",      sql.Int,           page)
            .input("PAGE_SIZE",        sql.Int,           size)
            .input("INCLUDE_INACTIVE", sql.Bit,           b.includeInactive ? 1 : 0)
            .execute("PROC_EB_GET_ALL_PRODUCTS");

        // group the images by product, then attach to each product
        const imagesByProduct = {};
        for (const img of result.recordsets[3] || []) {
            (imagesByProduct[img.productId] ||= []).push({
                url: img.url, alt: img.alt, isPrimary: !!img.isPrimary
            });
        }
        const products = (result.recordsets[1] || []).map(p => ({
            ...p,
            images: imagesByProduct[p.id] || (p.imageUrl ? [{ url: p.imageUrl, alt: p.product, isPrimary: true }] : [])
        }));

        const total = (result.recordsets[2] || [])[0]?.TOTAL_RECORDS ?? 0;
        res.status(200).json({
            success: true,
            categories: result.recordsets[0] || [],
            products,
            pagination: { pageNumber: page, pageSize: size, totalProducts: total, totalPages: Math.ceil(total / size) }
        });
    } catch (error) {
        sendError(res, error, "Get Products");
    }
});


module.exports = router