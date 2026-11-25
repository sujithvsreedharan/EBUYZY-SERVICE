const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const router = express.Router();
const { sql, poolPromise } = require("../config");
const { Bit } = require('mssql');

// Ensure uploads/products folder exists
const uploadDir = path.join(__dirname, '../../uploads/products');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Multer storage configuration for local product images
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const parsed = path.parse(file.originalname);
        // keep clean base name (e.g. rice) and extension (e.g. .jpeg)
        const cleanBase = parsed.name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase() || 'product';
        const ext = (parsed.ext || '.jpg').toLowerCase();
        let targetName = `${cleanBase}${ext}`;
        if (fs.existsSync(path.join(uploadDir, targetName))) {
            targetName = `${cleanBase}-${Date.now()}${ext}`;
        }
        cb(null, targetName);
    }
});

const fileFilter = (req, file, cb) => {
    const allowed = /jpeg|jpg|png|webp|gif|svg/;
    const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
    const mime = file.mimetype;
    if (allowed.test(ext) || allowed.test(mime)) {
        cb(null, true);
    } else {
        cb(new Error('Only image files (jpg, jpeg, png, webp, gif, svg) are allowed'));
    }
};

const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit per image
    fileFilter
});

const emptyToNull = (val) => {
    if (val === undefined || val === null || val === "" || (typeof val === "string" && val.trim() === "")) {
        return null;
    }
    return val;
};

// Helper: Ensure only file name and extension (e.g. "rice.jpeg") is saved in the database table
const extractFileNameOnly = (val) => {
    if (!val || typeof val !== 'string') return null;
    const clean = val.trim();
    if (!clean || clean.includes('ebuyzy-icon-2') || clean.includes('unsplash.com')) return null;
    const fileName = clean.replace(/\\/g, "/").split("/").pop().trim();
    return fileName || null;
};

const sendError = (res, error, action = "Operation") => {
    console.error(`${action} Error:`, error);
    return res.status(500).json({
        success: false,
        message: error.message || `${action} failed`,
        error: error.message
    });
};

// Image Upload Endpoint (1 main image, up to 10 gallery images)
router.post("/admin/uploadProductImages", upload.fields([
    { name: 'mainImage', maxCount: 1 },
    { name: 'galleryImages', maxCount: 10 }
]), async (req, res) => {
    try {
        let mainFileName = null;
        let galleryFileNames = [];

        if (req.files && req.files['mainImage'] && req.files['mainImage'][0]) {
            mainFileName = req.files['mainImage'][0].filename;
        }

        if (req.files && req.files['galleryImages'] && req.files['galleryImages'].length > 0) {
            galleryFileNames = req.files['galleryImages'].map(f => f.filename);
        }

        res.status(200).json({
            success: true,
            mainImage: mainFileName,        // e.g. "rice.jpeg"
            mainImageUrl: mainFileName ? `/uploads/products/${mainFileName}` : null,
            galleryImages: galleryFileNames, // e.g. ["rice-front.jpeg", "rice-back.jpeg"]
            galleryImageUrls: galleryFileNames.map(f => `/uploads/products/${f}`)
        });
    } catch (error) {
        sendError(res, error, "Upload Product Images");
    }
});

// Get Single Product by ID (including gallery images)
const getProductByIdHandler = async (req, res) => {
    try {
        const id = Number(req.body.id || req.body.productId);
        if (!Number.isInteger(id) || id < 1) {
            return res.status(400).json({ success: false, message: "Invalid product ID" });
        }

        const pool = await poolPromise;
        const result = await pool.request()
            .input("PRODUCT_ID", sql.Int, id)
            .execute("PROC_EB_GET_PRODUCT_BY_ID");

        const product = (result.recordsets[0] || [])[0];
        if (!product) {
            return res.status(404).json({ success: false, message: "Product not found" });
        }

        const galleryImages = (result.recordsets[1] || [])
            .map(img => extractFileNameOnly(img.IMAGE_URL))
            .filter(Boolean);

        res.status(200).json({
            success: true,
            data: {
                ...product,
                galleryImages
            }
        });
    } catch (error) {
        sendError(res, error, "Get Product By ID");
    }
};

router.post("/admin/getProductById", getProductByIdHandler);
router.post("/getProductDetails", getProductByIdHandler);

router.post("/admin/addProduct", async (req, res) => {
    try {
        const b = req.body;

        if (!b.productName || b.mrp === undefined || b.mrp === null || b.mrp === "") {
            return res.status(400).json({
                success: false,
                message: "Product name and MRP are required"
            });
        }
        console.log("req", b);

        const mainImageName = extractFileNameOnly(b.productImage || b.imageUrl || b.mainImage);

        const pool = await poolPromise;
        const result = await pool.request()
            .input("PRODUCT_NAME", sql.NVarChar(200), b.productName)
            .input("CATEGORY_ID", sql.Int, emptyToNull(b.categoryId))
            .input("CATEGORY_NAME", sql.NVarChar(100), emptyToNull(b.categoryName))
            .input("PRODUCT_DESC", sql.NVarChar(sql.MAX), emptyToNull(b.description))
            .input("UNIT", sql.NVarChar(30), emptyToNull(b.unit) ?? "1 item")
            .input("MRP", sql.Decimal(12, 2), b.mrp)
            .input("SELLING_PRICE", sql.Decimal(12, 2), emptyToNull(b.sellingPrice))
            .input("STOCK_QTY", sql.Decimal(12, 3), b.stock ?? 0)
            .input("PRODUCT_IMAGE", sql.NVarChar(500), mainImageName)
            .input("IS_FEATURED", sql.Bit, b.isFeatured ? 1 : 0)
            .input("PRODUCT_CODE", sql.NVarChar(50), emptyToNull(b.code))
            .input("OFFER_TYPE", sql.NVarChar(10), emptyToNull(b.offerType))
            .input("OFFER_VALUE", sql.Decimal(12, 2), emptyToNull(b.offerValue))
            .input("OFFER_START_DATE", sql.DateTime2, emptyToNull(b.offerStartDate))
            .input("OFFER_END_DATE", sql.DateTime2, emptyToNull(b.offerEndDate))
            .input("GROUP_ID", sql.Int, emptyToNull(b.groupId))
            .execute("PROC_EB_ADMIN_ADD_PRODUCT");

        const product = (result.recordsets[0] || [])[0];
        const newProdId = product?.PRODUCT_SLNO || product?.id;

        // Insert gallery images if provided - ONLY filename and extension
        if (newProdId && Array.isArray(b.galleryImages) && b.galleryImages.length > 0) {
            for (let i = 0; i < b.galleryImages.length; i++) {
                const gFileName = extractFileNameOnly(b.galleryImages[i]);
                if (gFileName) {
                    await pool.request()
                        .input("PRODUCT_DR", sql.Int, newProdId)
                        .input("IMAGE_URL", sql.NVarChar(1000), gFileName)
                        .input("IMAGE_ALT", sql.NVarChar(400), b.productName || null)
                        .input("IS_PRIMARY", sql.Bit, 0)
                        .input("SORT_ORDER", sql.Int, i + 2)
                        .input("IS_ACTIVE", sql.Bit, 1)
                        .query(`
                            INSERT INTO dbo.EB_PRODUCT_IMAGE
                            (PRODUCT_DR, IMAGE_URL, IMAGE_ALT, IS_PRIMARY, SORT_ORDER, IS_ACTIVE, CREATED_AT)
                            VALUES (@PRODUCT_DR, @IMAGE_URL, @IMAGE_ALT, @IS_PRIMARY, @SORT_ORDER, @IS_ACTIVE, GETDATE())
                        `);
                }
            }
        }

        res.status(200).json({ success: true, data: product });
    } catch (error) {
        sendError(res, error, "Add Product");
    }
});

router.post("/admin/updateProduct", async (req, res) => {
    try {
        const b = req.body;
        const id = Number(b.id);

        if (!Number.isInteger(id) || id < 1 || !b.productName ||
            b.mrp === undefined || b.mrp === null || b.mrp === "") {
            return res.status(400).json({
                success: false,
                message: "Product id, name and MRP are required"
            });
        }
        console.log('update', b);

        const mainImageName = extractFileNameOnly(b.productImage || b.imageUrl || b.mainImage);

        const pool = await poolPromise;
        const result = await pool.request()
            .input("PRODUCT_SLNO", sql.Int, id)
            .input("PRODUCT_NAME", sql.NVarChar(200), b.productName)
            .input("CATEGORY_ID", sql.Int, emptyToNull(b.categoryId))
            .input("CATEGORY_NAME", sql.NVarChar(100), emptyToNull(b.categoryName))
            .input("PRODUCT_DESC", sql.NVarChar(sql.MAX), emptyToNull(b.description))
            .input("UNIT", sql.NVarChar(30), emptyToNull(b.unit))
            .input("MRP", sql.Decimal(12, 2), b.mrp)
            .input("SELLING_PRICE", sql.Decimal(12, 2), emptyToNull(b.sellingPrice))
            .input("STOCK_QTY", sql.Decimal(12, 3), emptyToNull(b.stock))
            .input("PRODUCT_IMAGE", sql.NVarChar(500), mainImageName)
            .input("IS_FEATURED", sql.Bit, b.isFeatured === undefined ? null : (b.isFeatured ? 1 : 0))
            .input("IS_ACTIVE", sql.Bit, b.isActive === undefined ? null : (b.isActive ? 1 : 0))
            // always sent: an empty offerType clears the offer
            .input("OFFER_TYPE", sql.NVarChar(10), emptyToNull(b.offerType))
            .input("OFFER_VALUE", sql.Decimal(12, 2), emptyToNull(b.offerValue))
            .input("OFFER_START_DATE", sql.DateTime2, emptyToNull(b.offerStartDate))
            .input("OFFER_END_DATE", sql.DateTime2, emptyToNull(b.offerEndDate))
            .execute("PROC_EB_ADMIN_UPDATE_PRODUCT");

        // Sync gallery images if provided - ONLY filename and extension
        if (Array.isArray(b.galleryImages)) {
            // Delete old non-primary gallery images for this product
            await pool.request()
                .input("PRODUCT_DR", sql.Int, id)
                .query(`DELETE FROM dbo.EB_PRODUCT_IMAGE WHERE PRODUCT_DR = @PRODUCT_DR AND (IS_PRIMARY = 0 OR IS_PRIMARY IS NULL)`);

            for (let i = 0; i < b.galleryImages.length; i++) {
                const gFileName = extractFileNameOnly(b.galleryImages[i]);
                if (gFileName) {
                    await pool.request()
                        .input("PRODUCT_DR", sql.Int, id)
                        .input("IMAGE_URL", sql.NVarChar(1000), gFileName)
                        .input("IMAGE_ALT", sql.NVarChar(400), b.productName || null)
                        .input("IS_PRIMARY", sql.Bit, 0)
                        .input("SORT_ORDER", sql.Int, i + 2)
                        .input("IS_ACTIVE", sql.Bit, 1)
                        .query(`
                            INSERT INTO dbo.EB_PRODUCT_IMAGE
                            (PRODUCT_DR, IMAGE_URL, IMAGE_ALT, IS_PRIMARY, SORT_ORDER, IS_ACTIVE, CREATED_AT)
                            VALUES (@PRODUCT_DR, @IMAGE_URL, @IMAGE_ALT, @IS_PRIMARY, @SORT_ORDER, @IS_ACTIVE, GETDATE())
                        `);
                }
            }
        }

        res.status(200).json({ success: true, data: result.recordset[0] });
    } catch (error) {
        sendError(res, error, "Update Product");
    }
});

router.post("/admin/updateStock", async (req, res) => {
    try {
        const id = Number(req.body.id);
        const { quantity, delta } = req.body;

        if (!Number.isInteger(id) || id < 1) {
            return res.status(400).json({ success: false, message: "Invalid product ID" });
        }
        if (emptyToNull(quantity) === null && emptyToNull(delta) === null) {
            return res.status(400).json({
                success: false,
                message: "Send either quantity or delta"
            });
        }

        const pool = await poolPromise;
        const result = await pool.request()
            .input("PRODUCT_SLNO",     sql.Int,            id)
            .input("NEW_QUANTITY",     sql.Decimal(12, 3), emptyToNull(quantity))
            .input("ADJUSTMENT_DELTA", sql.Decimal(12, 3), emptyToNull(delta))
            .execute("PROC_EB_ADMIN_UPDATE_STOCK");

        res.status(200).json({ success: true, data: result.recordset[0] });
    } catch (error) {
        sendError(res, error, "Update Stock");
    }
});

router.post("/admin/deleteProduct", async (req, res) => {
    try {
        const id = Number(req.body.id);
        const hardDelete = Bit(req.body.hardDelete ? 1 : 0)
        if (!Number.isInteger(id) || id < 1) {
            return res.status(400).json({ success: false, message: "Invalid product ID" });
        }

        const pool = await poolPromise;
        const result = await pool.request()
            .input("PRODUCT_SLNO", sql.Int, id)
            .input("HARD_DELETE",  sql.Bit, hardDelete)
            .execute("PROC_EB_ADMIN_DELETE_PRODUCT");

        const row = result.recordset[0];
        res.status(200).json({
            success: true,
            deleteType: row.deleteType,   // 'HARD' or 'SOFT'
            message: row.message
        });
    } catch (error) {
        sendError(res, error, "Delete Product");
    }
});


module.exports = router