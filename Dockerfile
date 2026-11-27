# התמונה הרשמית של Playwright כוללת Chromium ותלויותיו
FROM mcr.microsoft.com/playwright:v1.47.0-jammy

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
COPY public ./public

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# מריצים כמשתמש שאינו root, כדי שהסנדבוקס של Chromium יישאר פעיל
USER pwuser
CMD ["node", "server.js"]
