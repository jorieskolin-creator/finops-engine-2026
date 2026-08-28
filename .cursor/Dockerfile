# Base image for the FinOps Engine Cloud Agent environment.
# Provides the stable system dependencies the dev stack needs:
#   - PostgreSQL 16 (content-free authoritative control plane)
#   - Redis (deadline-bounded execution plane)
#   - Node.js 20 toolchain (matches CI) + build tooling for native npm modules
# Repository dependencies are installed later by .cursor/install.sh against the
# checked-out source, so this image intentionally copies no repository files.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# System packages. `postgresql` on Ubuntu 24.04 resolves to PostgreSQL 16.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        gnupg \
        git \
        sudo \
        locales \
        build-essential \
        python3 \
        postgresql \
        postgresql-contrib \
        redis-server \
    && rm -rf /var/lib/apt/lists/*

# Node.js 20 from NodeSource (bundles npm), matching the CI toolchain.
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# The base image ships a non-root `ubuntu` user (uid 1000). Grant passwordless
# sudo so .cursor/start.sh can manage the PostgreSQL cluster and Redis daemon.
RUN echo 'ubuntu ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/90-ubuntu-nopasswd \
    && chmod 0440 /etc/sudoers.d/90-ubuntu-nopasswd

USER ubuntu
