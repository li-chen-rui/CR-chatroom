const session = require('express-session');
const config = require('../../config');

module.exports = session({
    secret: config.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: config.SESSION_MAX_AGE
    }
});