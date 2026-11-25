const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || "ebuyzy_super_secret_jwt_key_2026";

function requireAuth(req, res, next) {
    const header = req.headers.authorization || "";
    let token  = header.startsWith("Bearer ") ? header.slice(7).trim() : (header.startsWith("Bearer") ? header.slice(6).trim() : null);

    if (!token && req.query && req.query.token) {
        token = req.query.token;
    }

    if (!token) {
        return res.status(401).json({ success: false, message: "Sign in to continue" });     
    }

    try {
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch (e) {
        return res.status(401).json({ success: false, message: "Your session expired. Sign in again." });
    }
}

function requireRole(...allowedRoles) {
    return (req, res, next) => {
        const userRole = String(req.user?.role || "").toUpperCase();
        const matches = allowedRoles.some((role) => {
            const exp = String(role || "").toUpperCase();
            return userRole === exp || (exp === "ADMIN" && (userRole === "2" || userRole === "SUPERADMIN"));
        });

        if (!matches) {
            return res.status(403).json({ success: false, message: "You don't have access to this" });
        }
        next();
    };
}

function requireAdmin(req, res, next) {
    requireAuth(req, res, () => {
        const roleStr = String(req.user.role || "").toUpperCase();
        if (roleStr !== "2" && roleStr !== "ADMIN" && roleStr !== "SUPERADMIN" && req.user.role !== 2) {
            return res.status(403).json({ success: false, message: "You don't have access to this" });
        }
        next();
    });
}

function requireStaffManager(req, res, next) {
    requireAuth(req, res, () => {
        const roleStr = String(req.user?.role || "").toUpperCase();
        if (roleStr === "0" || roleStr === "CUSTOMER") {
            return res.status(403).json({ success: false, message: "Staff access required" });
        }
        next();
    });
}

module.exports = {
    requireAuth,
    authenticate: requireAuth,
    requireAdmin,
    requireRole,
    requireStaffManager
};
