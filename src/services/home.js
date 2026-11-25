const express = require("express");
const router = express.Router();

// Import database connection
const {poolPromise,sql} = require("../config");

router.post("/getStoreDetails", async (req, res) => {
    console.log('123456789');
    
    try {
        const { latitude, longitude } = req.body;
        console.log('gggg',req.body);
        

        // Validate input
        if (
            latitude === undefined ||
            longitude === undefined ||
            latitude === null ||
            longitude === null ||
            latitude === "" ||
            longitude === ""
        ) {
            return res.status(400).json({
                success: false,
                message: "Latitude and longitude are required"
            });
        }

        const lat = Number(latitude);
        const lon = Number(longitude);

        if (
            !Number.isFinite(lat) ||
            !Number.isFinite(lon) ||
            lat < -90 || lat > 90 ||
            lon < -180 || lon > 180
        ) {
            return res.status(400).json({
                success: false,
                message: "Invalid latitude or longitude"
            });
        }

        // Database connection
        const pool = await poolPromise;

        // Execute stored procedure
        const result = await pool.request()
            .input("LATTITUDE", sql.NVarChar(100), String(lat))
            .input("LONGITUDE", sql.NVarChar(100), String(lon))
            .execute("PROC_GET_STORE_DETAILS");

        const recordsets = result.recordsets || [];

        // Extract store details
        const storeSet = recordsets.find(
            set => set.length > 0 && set[0].store_id !== undefined
        );

        // Extract status and message
        const statusSet = recordsets.find(
            set => set.length > 0 && set[0].STATUS !== undefined
        );

        // Extract delivery details
        const deliverySet = recordsets.find(
            set => set.length > 0 && set[0].fixed_charge !== undefined
        );

        const statusData = statusSet ? statusSet[0] : {};

        return res.status(200).json({
            success: true,
            status: statusData.STATUS ?? 0,
            message: statusData.MESSAGE ?? "No store information available",
            description: statusData.DESCRIPTION ?? "",
            storeDetails: storeSet || [],
            deliveryDetails: deliverySet || []
        });

    } catch (error) {
        console.error("Get Store Details API Error:", error);

        res.status(500).json({
            success: false,
            message: "Internal Server Error"
        });
    }
});

// GET HOME PAGE PRODUCTS
router.post("/getHomePageProducts", async (req, res) => {
    try {
        const {
            categoryId = null,
            search = null,
            pageNumber = 1,
            pageSize = 20
        } = req.body;

        // Validate pagination
        const page = Number(pageNumber);
        const size = Number(pageSize);

        if (
            !Number.isInteger(page) || page < 1 ||
            !Number.isInteger(size) || size < 1
        ) {
            return res.status(400).json({
                success: false,
                message: "Invalid page number or page size"
            });
        }

        // Validate category
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

        // Database connection
        const pool = await poolPromise;

        // Execute stored procedure
        const result = await pool.request()
            .input("CATEGORY_ID", sql.Int, category)
            .input("SEARCH", sql.NVarChar(200), search || null)
            .input("PAGE_NUMBER", sql.Int, page)
            .input("PAGE_SIZE", sql.Int, size)
            .execute("PROC_EB_GET_HOME_PAGE_DATA");

        // Extract result sets
        const categories = result.recordsets[0] || [];
        const offeredProducts = result.recordsets[1] || [];
        const countData = result.recordsets[2] || [];

        const totalProducts = countData.length > 0
            ? countData[0].TOTAL_OFFERED_PRODUCTS
            : 0;

        const baseURL = `${req.protocol}://${req.get("host")}`;
        const formatImg = (img) => {
            if (!img) return null;
            if (String(img).startsWith('http://') || String(img).startsWith('https://')) return img;
            const fileName = String(img).replace(/\\/g, "/").split("/").pop();
            return fileName ? `${baseURL}/uploads/products/${encodeURIComponent(fileName)}` : null;
        };

        const offeredWithImages = offeredProducts.map(p => ({
            ...p,
            productImage: formatImg(p.productImage)
        }));

        res.status(200).json({
            success: true,
            message: "Home page products fetched successfully",

            categories: categories,

            offeredProducts: offeredWithImages,

            pagination: {
                pageNumber: page,
                pageSize: size,
                totalProducts: totalProducts,
                totalPages: Math.ceil(totalProducts / size)
            }
        });

    } catch (error) {
        console.error("Get Home Page Products API Error:", error);

        res.status(500).json({
            success: false,
            message: "Internal Server Error"
        });
    }
});


module.exports = router