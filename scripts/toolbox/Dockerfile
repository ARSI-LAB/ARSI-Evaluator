FROM docker:28.5.1-cli AS docker-cli
FROM node:24.22.1-bookworm-slim

ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org
ENV NPM_CONFIG_REGISTRY=${NPM_CONFIG_REGISTRY}
ENV HOME=/toolbox-home
ENV PNPM_HOME=/toolbox-home/.local/share/pnpm \
    EVALUATOR_DOCKER_CLI=/usr/local/bin/docker
ENV PATH="/toolbox-home/.local/share/pnpm/bin:/toolbox-home/.local/share/pnpm:/opt/evaluator-toolbox:${PATH}"

COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/ /usr/local/libexec/docker/cli-plugins/
# Bootstrap HTTPS apt on node:slim before ca-certificates can be installed.
COPY --from=docker-cli /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY docker-host.sh /opt/evaluator-toolbox/docker
COPY entrypoint.sh /opt/evaluator-toolbox/entrypoint.sh
RUN chmod +x /opt/evaluator-toolbox/docker /opt/evaluator-toolbox/entrypoint.sh

RUN apt-get update && \
    apt-get install -y --no-install-recommends bash git openssh-client ca-certificates python3 python3-venv python3-dev build-essential && \
    rm -rf /var/lib/apt/lists/* && \
    npm install --global pnpm@11.22.0 --ignore-scripts

ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

# Keep Chinese paths readable in interactive Bash, including with a persisted HOME.
RUN printf '\n%s\n' \
    'set input-meta on' \
    'set output-meta on' \
    'set convert-meta off' >> /etc/inputrc

ENTRYPOINT ["/opt/evaluator-toolbox/entrypoint.sh"]
CMD ["bash"]
