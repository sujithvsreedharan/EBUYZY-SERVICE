const express = require("express");
const router = express.Router();
const { sql, poolPromise } = require("../config");
const { requireAuth } = require("../middleware/auth");
const { sendError } = require("../utils/helpers");
const { addClient, removeClient } = require("../utils/notifyHub");

// live stream: one open connection per browser
router.get("/notifications/stream", requireAuth, (req, res) => {
    res.set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no"          // stops nginx from holding the data back
    });
    res.flushHeaders();
    res.write("retry: 5000\n\n");

    const userId = req.user.id;
    addClient(userId, res);

    const ping = setInterval(() => res.write(": ping\n\n"), 25000);   // keeps proxies from closing it
    req.on("close", () => {
        clearInterval(ping);
        removeClient(userId, res);
    });
});

// saved list and unread count
router.post("/notifications/list", requireAuth, async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request()
            .input("uid", sql.Int, req.user.id)
            .query(`SELECT TOP 50 NOTIF_SLNO AS id, NOTIF_TYPE AS type, TITLE AS title, BODY AS body,
                           ORDER_DR AS orderId, LINK AS link, IS_READ AS isRead, CREATED_AT AS createdAt
                    FROM dbo.EB_NOTIFICATION WHERE USER_DR = @uid ORDER BY NOTIF_SLNO DESC;
                    SELECT COUNT(*) AS unread FROM dbo.EB_NOTIFICATION WHERE USER_DR = @uid AND IS_READ = 0;`);

        res.status(200).json({
            success: true,
            notifications: result.recordsets[0],
            unread: result.recordsets[1][0].unread
        });
    } catch (error) {
        sendError(res, error, "Get Notifications");
    }
});

// mark one as read (only your own)
router.post("/notifications/read", requireAuth, async (req, res) => {
    try {
        const id = Number(req.body.id);
        if (!Number.isInteger(id) || id < 1) {
            return res.status(400).json({ success: false, message: "Invalid notification" });
        }
        const pool = await poolPromise;
        await pool.request()
            .input("id", sql.Int, id)
            .input("uid", sql.Int, req.user.id)
            .query("UPDATE dbo.EB_NOTIFICATION SET IS_READ = 1, READ_AT = SYSDATETIME() WHERE NOTIF_SLNO = @id AND USER_DR = @uid AND IS_READ = 0");
        res.status(200).json({ success: true });
    } catch (error) {
        sendError(res, error, "Mark Notification Read");
    }
});

router.post("/notifications/readAll", requireAuth, async (req, res) => {
    try {
        const pool = await poolPromise;
        await pool.request()
            .input("uid", sql.Int, req.user.id)
            .query("UPDATE dbo.EB_NOTIFICATION SET IS_READ = 1, READ_AT = SYSDATETIME() WHERE USER_DR = @uid AND IS_READ = 0");
        res.status(200).json({ success: true });
    } catch (error) {
        sendError(res, error, "Mark All Read");
    }
});

module.exports = router;