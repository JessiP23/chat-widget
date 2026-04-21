FROM nginx:alpine
COPY embed.html  /usr/share/nginx/html/embed.html
COPY loader.js   /usr/share/nginx/html/loader.js
COPY widget.js   /usr/share/nginx/html/widget.js
COPY nginx.conf  /etc/nginx/conf.d/default.conf
EXPOSE 8080
