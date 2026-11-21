ARG BUILD_FROM
FROM $BUILD_FROM
RUN apk add --no-cache nodejs
# Laid out exactly as in the product repository, so the service's relative paths hold.
COPY vincent /opt/vincent
WORKDIR /opt/vincent/apps/hub
# with-contenv hands the service the token Home Assistant issues to it.
CMD [ "/bin/sh", "-c", "exec with-contenv node --experimental-strip-types --disable-warning=ExperimentalWarning src/index.ts" ]
