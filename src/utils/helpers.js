// utils/helpers.js

const emptyToNull = (val) =>
    (val === undefined || val === null || (typeof val === "string" && val.trim() === "")) ? null : val;

const sendError = (res, error, action = "Operation") => {
    console.error(`${action} Error:`, error);
    // SP THROW 50000-59999 = our own messages, safe to show
    const isValidation = error.number >= 50000 && error.number < 60000;
    return res.status(isValidation ? 400 : 500).json({
        success: false,
        message: isValidation ? error.message : `${action} failed. Try again.`
    });
};

module.exports = { emptyToNull, sendError };