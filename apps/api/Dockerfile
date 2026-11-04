ARG GO_BUILD_IMAGE=golang:1.27-alpine
ARG DISTROLESS_IMAGE=gcr.io/distroless/static-debian12:nonroot

FROM ${GO_BUILD_IMAGE} AS build
WORKDIR /src
COPY apps/api/go.mod apps/api/go.sum ./
RUN go mod download
COPY apps/api ./
RUN CGO_ENABLED=0 go build -o /out/api ./cmd/api \
 && CGO_ENABLED=0 go build -o /out/worker ./cmd/worker \
 && CGO_ENABLED=0 go build -o /out/migrate ./cmd/migrate

# CI-only target for compose profile semantic-fake (plan P05 Task 16, SPEC §4.4).
# The production stage stays last so default builds never include fakeembed.
FROM ${GO_BUILD_IMAGE} AS build-fakeembed
WORKDIR /src
COPY apps/api/go.mod apps/api/go.sum ./
RUN go mod download
COPY apps/api ./
RUN CGO_ENABLED=0 go build -o /out/fakeembed ./cmd/fakeembed

FROM ${DISTROLESS_IMAGE} AS fakeembed
COPY --from=build-fakeembed /out/fakeembed /app/fakeembed
USER nonroot
ENTRYPOINT []

FROM ${DISTROLESS_IMAGE}
COPY --from=build /out/ /app/
USER nonroot
ENTRYPOINT []
