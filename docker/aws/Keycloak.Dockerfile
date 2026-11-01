FROM quay.io/keycloak/keycloak:26.8.1
COPY --chown=keycloak:keycloak docker/keycloak/wagering-realm.json /opt/keycloak/data/import/wagering-realm.json
