# Local isolation stand-in only. This image is not a Swarm host or release evidence.
FROM busybox@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec
CMD ["sh", "-ec", "mkdir -p /data/www; printf '%s' \"$SWARM_TENANT_ID\" > /data/www/owner; touch \"/data/$SWARM_TENANT_ID\"; exec httpd -f -p 8080 -h /data/www"]
